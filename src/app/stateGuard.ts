// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

/** sha256 of a file's bytes, read in chunks so a large log cannot be held in memory whole. */
function hashFile(abs: string): string | null {
  let fd: number;
  try {
    fd = openSync(abs, 'r');
  } catch {
    return null; // vanished or unreadable between readdir and here
  }
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
      if (!entry.isFile()) continue;
      const hash = hashFile(abs);
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
