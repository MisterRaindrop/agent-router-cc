// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname } from 'node:path';
import type { ActivityOutcome, ActivityRecord } from '../domain/types.ts';
import {
  activityKey,
  activityState,
  readActivity,
  startActivityHeartbeat,
  writeActivity,
} from '../io/activity.ts';
import type { RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';

// `supervise` is intentionally generic and has no task contract from which to read a budget.
// Keep a real hard ceiling, but well above the review runs this command is intended to expose.
const MAX_WALL_MS = 24 * 60 * 60_000;
const STALL_MS = 20 * 60_000;
export const SUPERVISE_INTERNAL_ERROR_CODE = 70;

export interface SuperviseCommandSpec {
  paths: RouterPaths;
  label: string;
  logPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Internal test seam; production uses the shared 15-second activity heartbeat. */
  activityHeartbeatIntervalMs?: number;
}

export interface SuperviseCommandResult {
  exitCode: number;
  supervision: SupervisionOutcome | null;
  diagnostics: string[];
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

export class HeartbeatStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatStartupError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface ActivitySnapshot {
  record: ActivityRecord;
  identity: FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read one stable path binding: the record and inode must agree across the read. */
function activitySnapshot(path: string): ActivitySnapshot | null {
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
 * Install a complete activity document only when this label has no owner.
 *
 * `writeActivity` gives us the frozen schema, ownership token, and atomic JSON write. Linking
 * that complete inode into its deterministic final path adds the one property a read-then-write
 * check cannot provide: exactly one of two concurrent callers wins. A disconnected predecessor
 * is removed only through reclaimDisconnectedActivity's token-and-inode confirmation.
 */
function claimActivity(
  paths: RouterPaths,
  label: string,
): { path: string; record: ActivityRecord; identity: FileIdentity } {
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
    const signalNumber = osConstants.signals[outcome.signal as keyof typeof osConstants.signals];
    if (signalNumber !== undefined) return 128 + signalNumber;
  }
  // This is the status a shell uses when the command itself could not be found or launched.
  if (outcome.spawnError !== null) return 127;
  return 1;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal as keyof typeof osConstants.signals];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function finishActivity(
  claimed: { path: string; record: ActivityRecord; identity: FileIdentity },
  outcome: ActivityOutcome,
  diagnostics: string[],
  endedAt: string = new Date().toISOString(),
): void {
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
  } catch (error) {
    diagnostics.push(`could not remove activity ${claimed.path}: ${(error as Error).message}`);
  }
}

interface SignalBridge {
  readonly signal: NodeJS.Signals | null;
  setPgid(pgid: number): void;
  dispose(): void;
}

function bridgeTerminalSignals(diagnostics: string[]): SignalBridge {
  let signal: NodeJS.Signals | null = null;
  let pgid: number | null = null;

  const forward = (received: NodeJS.Signals): void => {
    signal ??= received;
    if (pgid === null) return;
    try {
      killProcessGroup(pgid, received);
    } catch (error) {
      diagnostics.push(`could not forward ${received} to worker group ${pgid}: ${(error as Error).message}`);
    }
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return {
    get signal() {
      return signal;
    },
    setPgid(nextPgid: number): void {
      pgid = nextPgid;
      if (signal !== null) forward(signal);
    },
    dispose(): void {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

/** Run one foreground command while publishing display-only liveness for this router process. */
export async function superviseCommand(spec: SuperviseCommandSpec): Promise<SuperviseCommandResult> {
  const claimed = claimActivity(spec.paths, spec.label);
  const workerHeartbeatPath = `${claimed.path}.worker-heartbeat`;
  const diagnostics: string[] = [];
  const signals = bridgeTerminalSignals(diagnostics);
  let activityHeartbeat: ReturnType<typeof startActivityHeartbeat> | undefined;
  let finished = false;

  try {
    activityHeartbeat = startActivityHeartbeat(
      claimed.path,
      claimed.record,
      spec.activityHeartbeatIntervalMs,
    );
    const heartbeatStarted = await activityHeartbeat.started;
    if (!heartbeatStarted.ok) {
      throw new HeartbeatStartupError(
        `activity heartbeat failed to start for '${spec.label}': ${heartbeatStarted.error.message}`,
      );
    }

    if (signals.signal !== null) {
      finishActivity(claimed, 'failed', diagnostics);
      finished = true;
      return { exitCode: signalExitCode(signals.signal), supervision: null, diagnostics };
    }

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
      onPgid: (pgid) => signals.setPgid(pgid),
    });
    const endedAt = new Date(supervision.endedAtMs).toISOString();
    const code = signals.signal === null ? exitCode(supervision) : signalExitCode(signals.signal);
    finishActivity(claimed, activityOutcome(supervision), diagnostics, endedAt);
    finished = true;
    return { exitCode: code, supervision, diagnostics };
  } catch (error) {
    if (!finished) {
      finishActivity(claimed, 'failed', diagnostics);
      finished = true;
    }
    throw error;
  } finally {
    activityHeartbeat?.stop();
    try {
      unlinkSync(workerHeartbeatPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        diagnostics.push(`could not remove worker heartbeat ${workerHeartbeatPath}: ${(error as Error).message}`);
      }
    }
    signals.dispose();
  }
}
