// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityOutcome, ActivityRecord } from '../domain/types.ts';
import { writeJsonAtomic } from './atomicWrite.ts';
import {
  DEFAULT_BEAT_MS,
  startJsonHeartbeat,
  type HeartbeatHandle,
} from './heartbeat.ts';
import { DEFAULT_STALE_MS } from './lock.ts';

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
