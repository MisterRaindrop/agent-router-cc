// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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

/** Read one stable path binding: the record and inode must agree across the read. */
function activitySnapshot(path: string): { record: ActivityRecord; identity: FileIdentity } | null {
  try {
    const before = statSync(path, { bigint: true });
    const record = readActivity(path);
    const after = statSync(path, { bigint: true });
    if (record === null || before.dev !== after.dev || before.ino !== after.ino) return null;
    return { record, identity: { dev: after.dev, ino: after.ino } };
  } catch {
    return null;
  }
}

/**
 * Remove exactly the disconnected inode we inspected, never a same-label replacement.
 *
 * The hard-link guard is an atomic reference to that inode. A competing claimant sees the
 * guard and fails closed; immediately before unlinking the public name we confirm both the
 * frozen owner token and the inode identity. No liveness rule is duplicated here.
 */
function reclaimDisconnectedActivity(path: string, expected: ActivityRecord): boolean {
  const reclaimPath = `${path}.reclaim`;
  try {
    linkSync(path, reclaimPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EEXIST') return false;
    throw error;
  }

  try {
    const guarded = activitySnapshot(reclaimPath);
    const current = activitySnapshot(path);
    if (
      guarded === null ||
      current === null ||
      guarded.record.owner_token !== expected.owner_token ||
      current.record.owner_token !== expected.owner_token ||
      !sameIdentity(guarded.identity, current.identity) ||
      activityState(current.record) !== 'disconnected'
    ) {
      return false;
    }
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
  } finally {
    try {
      unlinkSync(reclaimPath);
    } catch {
      /* a leftover guard only makes a later claim fail closed */
    }
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
    // A stale-record reclaimer holds this hard-link guard across its identity check and unlink.
    // Do not fill the public name during that narrow window.
    if (existsSync(`${path}.reclaim`)) {
      throw new ActivityAlreadyExistsError(label, path, readActivity(path));
    }
    for (;;) {
      try {
        linkSync(candidate, path);
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const existing = readActivity(path);
        if (
          existing === null ||
          activityState(existing) !== 'disconnected' ||
          !reclaimDisconnectedActivity(path, existing)
        ) {
          throw new ActivityAlreadyExistsError(label, path, existing);
        }
        // The stale inode is gone. The same exclusive link decides which waiting caller wins.
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
    try {
      writeActivity(claimed.path, { ...claimed.record, ended_at: endedAt, outcome });
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
  const fresh = nowMs - Date.parse(activity.beat_at) <= staleMs;
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
