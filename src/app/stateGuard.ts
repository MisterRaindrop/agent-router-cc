// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { activityKey } from '../io/activity.ts';
import type { RouterPaths } from '../io/paths.ts';

// Detection for Must NOT 11: "the executor must not write real .router/ orchestration state".
//
// ROUTER_EXECUTOR_SANDBOX only refuses a nested `router` CLI. It cannot stop an executor writing
// those files with a plain file API, a shell redirect, or its own editor tool -- and the review
// demonstrated exactly that: a fake executor created `.router/tasks/forged/result.json`, the
// dispatch still reported PASSED, the file stayed, and the committed diff showed only `src/a.ts`
// because `.router/` is gitignored and therefore invisible to every gate.
//
// Prevention would need the sandbox to exclude a subdirectory of its own writable root, which
// codex's `workspace-write` does not offer. So this enforces by DETECTION: fingerprint the state
// before launching the executor, compare after it exits, and fail the run on any difference. A
// detected violation is not as good as an impossible one, but it is enormously better than the
// silence it replaces.
//
// The fingerprint is a CONTENT HASH. It used to be `size:mtimeMs`, which the follow-up review
// walked straight through: overwrite a file with same-length content, restore the old mtime with
// `utimes`, and the diff comes back empty. Both halves of that are one line for anything with a
// filesystem API, so the guard was checking for carelessness rather than for tampering.

/**
 * Files the CLI itself -- or the user's own editor session -- legitimately writes while a run is
 * in progress, so a change to them cannot be evidence of anything.
 *
 * Every entry here is a hole, so every entry needs a reason that is about who else writes the
 * file, never about how unlikely tampering seems. Three previous entries were dropped when they
 * turned out to have no such reason: `metrics.jsonl` is not appended until after the comparison
 * (a forged row falsifies the usage report), and `worktrees/` is a deprecated path nothing writes
 * at all.
 */
function isOwnRunArtifact(rel: string, ownTaskId: string): boolean {
  const parts = rel.split(sep);
  const top = parts[0] ?? '';
  // The out-of-process heartbeat rewrites the lock every few seconds, and a reclaim can leave a
  // short-lived `gate.lock.reclaim` beside it. Excluded from the CONTENT diff only -- dispatch
  // separately asserts the lock still carries this run's owner token, so the exclusion is not
  // also a free channel for an executor to write itself a lock.
  if (top === 'gate.lock' || top.startsWith('gate.lock.')) return true;
  // Snapshotted by the statusline on every render, which is continuously, for the whole run.
  if (top === 'usage.json') return true;
  // A regenerable cache rather than orchestration state, and `router symbol index` takes no
  // checkout lock -- so a user rebuilding it in another terminal would otherwise fail the run.
  if (top === 'symbols') return true;
  if (top !== 'tasks' || parts[1] !== ownTaskId) return false;
  // Within our own task: status.json, heartbeat and logs/ are written continuously while the
  // executor runs. task.yaml and TASK_CONTRACT.md are NOT -- those are the contract, and an
  // executor rewriting its own contract mid-run is precisely what must be caught.
  const leaf = parts[2] ?? '';
  return leaf === 'status.json' || leaf === 'heartbeat' || leaf === 'logs';
}

/** Open a path only if that exact directory entry is still a regular file. */
function openRegularFile(abs: string): number | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null; // vanished or unreadable between readdir and here
  }
  try {
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    closeSync(fd);
    return null;
  }
}

/** sha256 of a file's bytes, read in chunks so a large log cannot be held in memory whole. */
function hashFile(abs: string): string | null {
  const fd = openRegularFile(abs);
  if (fd === null) return null;
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Read a regular file without following a link or blocking on a special file after a race. */
function readRegularFile(abs: string): Buffer | null {
  const fd = openRegularFile(abs);
  if (fd === null) return null;
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Hash of an activity record with the heartbeat field normalised away.
 *
 * Anything that does not parse as an activity-shaped object is hashed raw: a non-JSON file under
 * `activity/` is itself suspicious, and quietly ignoring it would be another hole.
 */
function hashActivity(abs: string): string | null {
  const bytes = readRegularFile(abs);
  if (bytes === null) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return createHash('sha256').update(bytes).digest('hex');
    }
  } catch {
    return createHash('sha256').update(bytes).digest('hex');
  }
  const normalised: Record<string, unknown> = { ...parsed, beat_at: '<beat>' };
  const canonical = Object.keys(normalised)
    .sort()
    .map((key) => `${key}=${JSON.stringify(normalised[key])}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Stable signature for a non-directory, non-regular entry without opening its contents. */
function specialEntryFingerprint(abs: string): string | null {
  try {
    const stat = lstatSync(abs);
    if (stat.isFile() || stat.isDirectory()) return null;
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    const type = stat.isFIFO()
      ? 'fifo'
      : stat.isSocket()
        ? 'socket'
        : stat.isBlockDevice()
          ? 'block-device'
          : stat.isCharacterDevice()
            ? 'character-device'
            : 'unknown';
    return `special:${type}`;
  } catch {
    return null;
  }
}

/** `relative path -> content hash` for every orchestration-state file that is not ours to write. */
export function fingerprintState(paths: RouterPaths, ownTaskId: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable: nothing to compare, and the run's own checks fail loudly
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(paths.root, abs);
      if (isOwnRunArtifact(rel, ownTaskId)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      // Somebody else's regular activity record: a concurrent, legitimate heartbeat rewrites
      // `beat_at` every few seconds, and failing a run over that would be a false alarm. A
      // symlink, FIFO, device, or socket is never opened; its type (and a link's target) is the
      // fingerprint, so replacing a watched file cannot make that path disappear from the guard.
      const hash = entry.isFile()
        ? (rel.split(sep)[0] === 'activity' ? hashActivity(abs) : hashFile(abs)) ??
          specialEntryFingerprint(abs)
        : specialEntryFingerprint(abs);
      if (hash !== null) out.set(rel, hash);
    }
  };
  walk(paths.root);
  return out;
}

/** What changed between two fingerprints, as human-readable lines. Empty means untouched. */
export function stateDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [rel, sig] of after) {
    const prior = before.get(rel);
    if (prior === undefined) changes.push(`created ${rel}`);
    else if (prior !== sig) changes.push(`modified ${rel}`);
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push(`deleted ${rel}`);
  return changes.sort();
}

export interface StateChangeTiers {
  /** Expected concurrent churn worth recording, but not evidence that invalidates the run. */
  reported: string[];
  /** Changes that can alter router decisions or forge an activity identity. */
  fatal: string[];
}

/**
 * Split observed state changes into reporting and failure tiers.
 *
 * Plans cannot change the frozen contract already handed to this run. Other activities may
 * legitimately appear and disappear while dispatch is in flight. By contrast, a modified
 * activity has changed identity (its heartbeat was normalised before hashing), and this task's
 * own activity cannot legitimately appear or disappear inside the fingerprint window: it is
 * claimed before the first snapshot and finished after the last one.
 */
export function classifyStateChanges(
  before: Map<string, string>,
  after: Map<string, string>,
  ownTaskId: string,
): StateChangeTiers {
  const reported: string[] = [];
  const fatal: string[] = [];
  const ownActivity = join('activity', `${activityKey(`task:${ownTaskId}`)}.json`);

  for (const change of stateDiff(before, after)) {
    const splitAt = change.indexOf(' ');
    const kind = splitAt === -1 ? '' : change.slice(0, splitAt);
    const rel = splitAt === -1 ? change : change.slice(splitAt + 1);
    const top = rel.split(sep)[0] ?? '';
    const nonFatal =
      top === 'plans' ||
      (top === 'activity' &&
        kind !== 'modified' &&
        rel !== ownActivity);
    (nonFatal ? reported : fatal).push(change);
  }

  return { reported, fatal };
}
