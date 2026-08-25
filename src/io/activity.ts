// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ActivityOutcome, ActivityRecord } from '../domain/types.ts';
import { writeJsonAtomic } from './atomicWrite.ts';
import {
  DEFAULT_BEAT_MS,
  startJsonHeartbeat,
  type HeartbeatHandle,
} from './heartbeat.ts';
import { DEFAULT_STALE_MS } from './lock.ts';
import type { RouterPaths } from './paths.ts';

const OUTCOMES = new Set<ActivityOutcome>(['ok', 'failed', 'timed_out', 'stalled']);
const MAX_PID = 0x7fff_ffff;
// Wall clocks may differ slightly across related processes, but a timestamp far in the future
// is not evidence of a fresh heartbeat. Keep the allowance deliberately much smaller than the
// shared 90-second stale window.
const MAX_FUTURE_BEAT_SKEW_MS = 5_000;
// A reclaim is a synchronous critical section whose filesystem boundaries may still be delayed.
// Renew at every boundary so a live reclaimer keeps its mutex; the lease exists only so SIGKILL
// cannot leave that mutex behind forever.
const RECLAIM_LEASE_MS = 30_000;

export type ActivityState = 'idle' | 'running' | 'disconnected';

export interface ActivityFile {
  path: string;
  record: ActivityRecord;
}

export interface ObservedActivity extends ActivityFile {
  state: Exclude<ActivityState, 'idle'>;
  beatAgeMs: number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface FileSnapshot {
  text: string;
  identity: FileIdentity;
  mtimeMs: number;
}

interface ActivitySnapshot extends FileSnapshot {
  record: ActivityRecord;
}

export type ActivityTestPoint =
  | 'reclaim-guard-established'
  | 'reclaim-liveness-confirmed'
  | 'reclaim-before-unlink'
  | 'reclaim-before-install'
  | 'finish-snapshot';

let activityTestHook: ((point: ActivityTestPoint) => void) | undefined;

/**
 * Internal deterministic barrier for crash/race tests. Production never installs this hook, so
 * the default path is one undefined check at each otherwise unobservable filesystem boundary.
 */
export function setActivityTestHookForTesting(
  hook: ((point: ActivityTestPoint) => void) | undefined,
): void {
  activityTestHook = hook;
}

function reachActivityTestPoint(point: ActivityTestPoint): void {
  activityTestHook?.(point);
}

export interface ClaimedActivity {
  path: string;
  record: ActivityRecord;
  identity: FileIdentity;
}

export interface ClaimActivityOptions {
  statusPath?: string;
}

export interface FinishActivityOptions {
  attempts?: number;
  retryDelayMs?: number;
}

export class ActivityAlreadyExistsError extends Error {
  readonly activity: ActivityRecord | null;
  readonly path: string;

  constructor(label: string, path: string, activity: ActivityRecord | null) {
    const owner =
      activity === null
        ? 'an unreadable existing activity'
        : `pid ${activity.pid}, started ${activity.started_at}`;
    super(`activity '${label}' is already claimed by ${owner} (${path})`);
    this.name = 'ActivityAlreadyExistsError';
    this.activity = activity;
    this.path = path;
  }
}

function finiteDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MAX_PID;
}

function parseActivity(value: unknown): ActivityRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (typeof object.label !== 'string' || object.label.length === 0) return null;
  if (typeof object.owner_token !== 'string' || object.owner_token.length === 0) return null;
  if (!validPid(object.pid)) return null;
  if (!finiteDate(object.started_at) || !finiteDate(object.beat_at)) return null;
  if (object.ended_at !== undefined && !finiteDate(object.ended_at)) return null;
  if (object.outcome !== undefined && !OUTCOMES.has(object.outcome as ActivityOutcome)) return null;
  if (object.status_path !== undefined && typeof object.status_path !== 'string') return null;

  const record: ActivityRecord = {
    label: object.label,
    owner_token: object.owner_token,
    pid: object.pid as number,
    started_at: object.started_at,
    beat_at: object.beat_at,
  };
  if (typeof object.ended_at === 'string') record.ended_at = object.ended_at;
  if (typeof object.outcome === 'string') record.outcome = object.outcome as ActivityOutcome;
  if (typeof object.status_path === 'string') record.status_path = object.status_path;
  return record;
}

/** Deterministically turn a display label into one path-component-safe key. */
export function activityKey(label: string): string {
  if (label.length === 0) throw new Error('activity label must not be empty');
  // A fixed-size lowercase digest is portable under case-insensitive filesystems and keeps even
  // arbitrarily long display labels comfortably below per-component filename limits.
  return createHash('sha256').update(label).digest('hex');
}

export type ActivityInput = Omit<ActivityRecord, 'owner_token'> | ActivityRecord;

/**
 * Atomically install a complete live activity document and return its ownership-bearing record.
 * Writing an ended record removes the display-only file instead of retaining unbounded history.
 */
export function writeActivity(path: string, activity: ActivityInput): ActivityRecord {
  const candidate = Object.prototype.hasOwnProperty.call(activity, 'owner_token')
    ? activity
    : { ...activity, owner_token: randomUUID() };
  const parsed = parseActivity(candidate);
  if (parsed === null) throw new Error(`cannot write invalid activity to ${path}`);
  if (parsed.ended_at !== undefined) {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return parsed;
  }
  writeJsonAtomic(path, parsed);
  return parsed;
}

/** Read one activity document; missing, torn, or schema-invalid contents are ignored. */
export function readActivity(path: string): ActivityRecord | null {
  try {
    return parseActivity(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read bytes and inode identity through one descriptor, never through two path resolutions. */
function fileSnapshot(path: string): FileSnapshot | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    return {
      text: readFileSync(fd, 'utf8'),
      identity: { dev: stat.dev, ino: stat.ino },
      mtimeMs: Number(stat.mtimeNs / 1_000_000n),
    };
  } finally {
    closeSync(fd);
  }
}

/** Read one activity record and its path binding from the same descriptor. */
function activitySnapshot(path: string): ActivitySnapshot | null {
  try {
    const snapshot = fileSnapshot(path);
    if (snapshot === null) return null;
    const record = parseActivity(JSON.parse(snapshot.text));
    return record === null ? null : { ...snapshot, record };
  } catch {
    return null;
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.text === right.text && sameIdentity(left.identity, right.identity);
}

/** Whether a path still names the exact bytes and inode that were inspected. */
function stillTheSameFile(path: string, expected: FileSnapshot): boolean {
  const current = fileSnapshot(path);
  return current !== null && sameSnapshot(current, expected);
}

interface ReclaimerRecord {
  pid: number;
  beatAtMs: number;
  token: string;
}

function parseReclaimer(text: string): ReclaimerRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!validPid(value.pid)) return null;
    if (typeof value.beatAtMs !== 'number' || !Number.isFinite(value.beatAtMs)) return null;
    if (typeof value.token !== 'string' || value.token.length === 0) return null;
    return { pid: value.pid as number, beatAtMs: value.beatAtMs, token: value.token };
  } catch {
    return null;
  }
}

function reclaimerText(token: string): string {
  return `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token })}\n`;
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === 'ESRCH';
  }
}

/** Publish a complete reclaim mutex atomically, with no live-but-empty create window. */
function installReclaimer(path: string, token: string): boolean {
  const staging = `${path}.${process.pid}.${token}.tmp`;
  try {
    writeFileSync(staging, reclaimerText(token), { flag: 'w' });
    const fd = openSync(staging, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(staging, path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw new Error(`cannot install activity reclaimer for ${path}: ${(error as Error).message}`);
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      /* the published hard link, if any, keeps the complete inode alive */
    }
  }
}

/** Clear only a mutex whose pid is gone or whose lease was not renewed for 30 seconds. */
function clearDeadReclaimer(path: string): boolean {
  const snapshot = fileSnapshot(path);
  if (snapshot === null) return true;
  const held = parseReclaimer(snapshot.text);
  const dead =
    held === null
      ? Date.now() - snapshot.mtimeMs > RECLAIM_LEASE_MS
      : pidIsGone(held.pid) || Date.now() - held.beatAtMs > RECLAIM_LEASE_MS;
  // A live reclaimer may have renewed or replaced the mutex since our read. Removing that new
  // file would admit two reclaimers, so bytes and inode are both re-confirmed immediately first.
  if (!dead || !stillTheSameFile(path, snapshot)) return false;
  try {
    unlinkSync(path);
  } catch {
    /* another contender clearing it first is the same successful outcome */
  }
  return true;
}

function stillReclaiming(path: string, token: string): boolean {
  try {
    const snapshot = fileSnapshot(path);
    return snapshot !== null && parseReclaimer(snapshot.text)?.token === token;
  } catch {
    return false;
  }
}

/** Push the lease out at a reclaim boundary. Silent if the guard is no longer ours. */
function renewReclaimer(path: string, token: string): void {
  if (!stillReclaiming(path, token)) return;
  try {
    writeFileSync(path, reclaimerText(token));
  } catch {
    /* a failed renewal only risks being overtaken; the token checks below still fail closed */
  }
}

function releaseReclaimer(path: string, token: string): void {
  if (!stillReclaiming(path, token)) return;
  try {
    unlinkSync(path);
  } catch {
    /* gone already */
  }
}

type ReclaimOutcome = 'installed' | 'retry' | 'busy' | 'recovered';

/**
 * Replace exactly one confirmed-disconnected activity under a leased, token-owned mutex.
 *
 * What the caller observed before the mutex is only a reason to inspect. Under the mutex we
 * re-read liveness, then immediately before unlink re-confirm the exact bytes and inode. This is
 * what prevents an in-place heartbeat between those steps from being deleted as stale.
 */
function reclaimDisconnectedActivity(
  path: string,
  expected: ActivitySnapshot,
  candidate: string,
): ReclaimOutcome {
  const reclaimPath = `${path}.reclaim`;
  const token = randomUUID();
  if (!installReclaimer(reclaimPath, token)) {
    return clearDeadReclaimer(reclaimPath) ? 'recovered' : 'busy';
  }

  try {
    renewReclaimer(reclaimPath, token);
    reachActivityTestPoint('reclaim-guard-established');
    const held = activitySnapshot(path);
    if (held === null || !sameSnapshot(held, expected)) return 'retry';
    if (activityState(held.record) !== 'disconnected') return 'retry';
    renewReclaimer(reclaimPath, token);
    reachActivityTestPoint('reclaim-liveness-confirmed');

    // The test point is intentionally before the final confirmation: a heartbeat resumed at the
    // last observable boundary must change the bytes and make this reclaim stand down.
    renewReclaimer(reclaimPath, token);
    reachActivityTestPoint('reclaim-before-unlink');
    if (!stillReclaiming(reclaimPath, token)) return 'retry';
    const confirmed = activitySnapshot(path);
    if (
      confirmed === null ||
      !sameSnapshot(confirmed, held) ||
      activityState(confirmed.record) !== 'disconnected'
    ) {
      return 'retry';
    }
    try {
      unlinkSync(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'retry';
      throw error;
    }

    renewReclaimer(reclaimPath, token);
    reachActivityTestPoint('reclaim-before-install');
    if (!stillReclaiming(reclaimPath, token)) return 'retry';
    try {
      linkSync(candidate, path);
      return 'installed';
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return 'retry';
      throw error;
    }
  } finally {
    releaseReclaimer(reclaimPath, token);
  }
}

/**
 * Install a complete activity document only when this label has no live owner.
 *
 * `writeActivity` gives us the frozen schema, ownership token, and atomic JSON write. Linking
 * that complete inode into its deterministic final path adds the one property a read-then-write
 * check cannot provide: exactly one of two concurrent callers wins. A disconnected predecessor
 * is removed only through reclaimDisconnectedActivity's token-and-inode confirmation.
 */
export function claimActivity(
  paths: RouterPaths,
  label: string,
  options: ClaimActivityOptions = {},
): ClaimedActivity {
  const path = paths.activity(activityKey(label));
  const candidate = `${path}.claim.${process.pid}.${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const record = writeActivity(candidate, {
    label,
    pid: process.pid,
    started_at: startedAt,
    beat_at: startedAt,
    ...(options.statusPath !== undefined ? { status_path: options.statusPath } : {}),
  });

  try {
    let recoveries = 0;
    for (;;) {
      const reclaimPath = `${path}.reclaim`;
      try {
        if (fileSnapshot(reclaimPath) !== null) {
          // Breaking one dead lease earns a free retry. A second recovery request is treated as
          // contention so a caller without a wait contract cannot spin forever.
          if (recoveries === 0 && clearDeadReclaimer(reclaimPath)) {
            recoveries += 1;
            continue;
          }
          throw new ActivityAlreadyExistsError(label, path, readActivity(path));
        }
      } catch (error) {
        if (error instanceof ActivityAlreadyExistsError) throw error;
        throw new Error(`cannot inspect activity reclaimer for ${path}: ${(error as Error).message}`);
      }

      try {
        linkSync(candidate, path);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const existing = activitySnapshot(path);
        if (existing === null || activityState(existing.record) !== 'disconnected') {
          throw new ActivityAlreadyExistsError(label, path, existing?.record ?? null);
        }
        const outcome = reclaimDisconnectedActivity(path, existing, candidate);
        if (outcome === 'installed') break;
        if (outcome === 'recovered' && recoveries === 0) {
          recoveries += 1;
          continue;
        }
        if (outcome === 'busy' || outcome === 'recovered') {
          throw new ActivityAlreadyExistsError(label, path, readActivity(path));
        }
        // A changed or vanished predecessor is re-read from the top. The exclusive link remains
        // the only operation that can install an owner.
      }
    }
  } finally {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  const installed = activitySnapshot(path);
  if (installed === null || installed.record.owner_token !== record.owner_token) {
    throw new Error(`could not confirm ownership of activity '${label}' at ${path}`);
  }
  return { path, record, identity: installed.identity };
}

function retryPause(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove only the claimed token-and-inode binding; failures are returned as diagnostics. */
export function finishActivity(
  claimed: ClaimedActivity,
  outcome: ActivityOutcome,
  diagnostics: string[],
  endedAt: string = new Date().toISOString(),
  options: FinishActivityOptions = {},
): void {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = activitySnapshot(claimed.path);
    if (
      current === null ||
      current.record.owner_token !== claimed.record.owner_token ||
      !sameIdentity(current.identity, claimed.identity)
    ) {
      diagnostics.push(`could not remove activity ${claimed.path}: ownership or file identity changed`);
      return;
    }
    reachActivityTestPoint('finish-snapshot');
    try {
      const finished = parseActivity({ ...claimed.record, ended_at: endedAt, outcome });
      if (finished === null) throw new Error(`cannot write invalid activity to ${claimed.path}`);
      // Re-resolve immediately before unlink. A replacement installed after the first snapshot
      // is not ours even if the old owner_token were somehow reused; inode identity closes that
      // window. A same-owner heartbeat may change bytes in place and is safe to finish.
      const confirmed = activitySnapshot(claimed.path);
      if (
        confirmed === null ||
        confirmed.record.owner_token !== claimed.record.owner_token ||
        !sameIdentity(confirmed.identity, claimed.identity)
      ) {
        diagnostics.push(
          `could not remove activity ${claimed.path}: ownership or file identity changed`,
        );
        return;
      }
      unlinkSync(claimed.path);
      return;
    } catch (error) {
      if (attempt === attempts) {
        diagnostics.push(`could not remove activity ${claimed.path}: ${(error as Error).message}`);
        return;
      }
      retryPause(retryDelayMs);
    }
  }
}

/**
 * Read every valid activity document independently.
 *
 * One corrupt file never hides its siblings. Atomic-write temp files and non-JSON directory
 * entries are ignored, and stable ordering keeps statusline rendering deterministic.
 */
function scanActivities(directory: string, includeEnded: boolean): ActivityFile[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const activities: ActivityFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(directory, entry.name);
    const record = readActivity(path);
    // Filter legacy ended records before sorting so old history cannot inflate every render's
    // O(n log n) work. New ended records are removed by writeActivity above.
    if (record !== null && (includeEnded || record.ended_at === undefined)) {
      activities.push({ path, record });
    }
  }
  return activities.sort(
    (left, right) =>
      Date.parse(left.record.started_at) - Date.parse(right.record.started_at) ||
      left.record.label.localeCompare(right.record.label),
  );
}

export function readActivities(directory: string): ActivityFile[] {
  return scanActivities(directory, true);
}

function pidIsAlive(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still proves that a process occupies the pid. Parameter and all other errors do not.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The single three-state rule: ended/absent is idle; otherwise pid AND heartbeat must be live. */
export function activityState(
  activity: ActivityRecord | null,
  nowMs: number = Date.now(),
  staleMs: number = DEFAULT_STALE_MS,
): ActivityState {
  if (activity === null || activity.ended_at !== undefined) return 'idle';
  const beatAgeMs = nowMs - Date.parse(activity.beat_at);
  const fresh = beatAgeMs >= -MAX_FUTURE_BEAT_SKEW_MS && beatAgeMs <= staleMs;
  return pidIsAlive(activity.pid) && fresh ? 'running' : 'disconnected';
}

/** Valid unfinished activities annotated with the shared liveness decision. Empty means idle. */
export function observeActivities(
  directory: string,
  nowMs: number = Date.now(),
  staleMs: number = DEFAULT_STALE_MS,
): ObservedActivity[] {
  const observed: ObservedActivity[] = [];
  for (const activity of scanActivities(directory, false)) {
    const state = activityState(activity.record, nowMs, staleMs);
    if (state === 'idle') continue;
    observed.push({
      ...activity,
      state,
      beatAgeMs: Math.max(0, nowMs - Date.parse(activity.record.beat_at)),
    });
  }
  return observed;
}

/** Start the cross-process ISO heartbeat for an activity that was already written atomically. */
export function startActivityHeartbeat(
  path: string,
  activity: ActivityRecord,
  intervalMs: number = DEFAULT_BEAT_MS,
): HeartbeatHandle {
  return startJsonHeartbeat(path, {
    field: 'beat_at',
    valueFormat: 'iso',
    guard: { owner_token: activity.owner_token },
    // writeJsonAtomic pretty-prints with two spaces. Matching that shape makes a heartbeat only
    // replace fixed-width ISO timestamp bytes instead of changing the document's length.
    indent: 2,
    intervalMs,
  });
}
