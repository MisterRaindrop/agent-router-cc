// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import type { ActivityOutcome, ActivityRecord } from '../domain/types.ts';
import {
  activityKey,
  readActivity,
  startActivityHeartbeat,
  writeActivity,
} from '../io/activity.ts';
import type { RouterPaths } from '../io/paths.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';

// `supervise` is intentionally generic and has no task contract from which to read a budget.
// Keep a real hard ceiling, but well above the review runs this command is intended to expose.
const MAX_WALL_MS = 24 * 60 * 60_000;
const STALL_MS = 20 * 60_000;

export interface SuperviseCommandSpec {
  paths: RouterPaths;
  label: string;
  logPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SuperviseCommandResult {
  exitCode: number;
  supervision: SupervisionOutcome;
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Install a complete activity document only when this label has no owner.
 *
 * `writeActivity` gives us the frozen schema, ownership token, and atomic JSON write. Linking
 * that complete inode into its deterministic final path adds the one property a read-then-write
 * check cannot provide: exactly one of two concurrent callers wins. A disconnected record is
 * deliberately not removed here; lost activities are display evidence, never an auto-cleanup
 * trigger.
 */
function claimActivity(paths: RouterPaths, label: string): { path: string; record: ActivityRecord } {
  const path = paths.activity(activityKey(label));
  const candidate = `${path}.claim.${process.pid}.${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const record = writeActivity(candidate, {
    label,
    pid: process.pid,
    started_at: startedAt,
    beat_at: startedAt,
  });

  try {
    linkSync(candidate, path);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new ActivityAlreadyExistsError(label, path, readActivity(path));
    }
    throw error;
  } finally {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  return { path, record };
}

function activityOutcome(outcome: SupervisionOutcome): ActivityOutcome {
  if (outcome.timedOut) return 'timed_out';
  if (outcome.stalled) return 'stalled';
  if (
    outcome.rc === 0 &&
    outcome.signal === null &&
    outcome.spawnError === null &&
    !outcome.groupSurvived
  ) {
    return 'ok';
  }
  return 'failed';
}

/** Shell-compatible status for a command that could not supply a numeric exit code. */
function exitCode(outcome: SupervisionOutcome): number {
  if (outcome.rc !== null) return outcome.rc;
  if (outcome.signal !== null) {
    const signalNumber = constants.signals[outcome.signal as keyof typeof constants.signals];
    if (signalNumber !== undefined) return 128 + signalNumber;
  }
  // This is the status a shell uses when the command itself could not be found or launched.
  if (outcome.spawnError !== null) return 127;
  return 1;
}

/** Run one foreground command while publishing display-only liveness for this router process. */
export async function superviseCommand(spec: SuperviseCommandSpec): Promise<SuperviseCommandResult> {
  const claimed = claimActivity(spec.paths, spec.label);
  const workerHeartbeatPath = `${claimed.path}.worker-heartbeat`;
  let activityHeartbeat: ReturnType<typeof startActivityHeartbeat> | undefined;
  let completed = false;

  try {
    activityHeartbeat = startActivityHeartbeat(claimed.path, claimed.record);

    // `router supervise --log file` has the same overwrite semantics as `> file 2>&1`.
    // Claim first: a rejected duplicate must never truncate the running owner's report.
    mkdirSync(dirname(spec.logPath), { recursive: true });
    writeFileSync(spec.logPath, '');

    const supervision = await superviseWorker({
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env,
      logPath: spec.logPath,
      heartbeatPath: workerHeartbeatPath,
      watchPaths: [],
      maxWallMs: MAX_WALL_MS,
      stallMs: STALL_MS,
    });
    const endedAt = new Date(supervision.endedAtMs).toISOString();
    writeActivity(claimed.path, {
      ...claimed.record,
      ended_at: endedAt,
      outcome: activityOutcome(supervision),
    });
    completed = true;
    return { exitCode: exitCode(supervision), supervision };
  } finally {
    // Unexpected wrapper failures are still normal lifecycle ends from the activity file's
    // point of view. SIGKILL cannot run this block, so a killed owner intentionally leaves the
    // record behind to be rendered as disconnected.
    if (!completed) {
      writeActivity(claimed.path, {
        ...claimed.record,
        ended_at: new Date().toISOString(),
        outcome: 'failed',
      });
    }
    activityHeartbeat?.stop();
    try {
      unlinkSync(workerHeartbeatPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
