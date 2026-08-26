// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname } from 'node:path';
import type { ActivityOutcome } from '../domain/types.ts';
import {
  ActivityAlreadyExistsError,
  claimActivity,
  finishActivity,
  startActivityHeartbeat,
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

export { ActivityAlreadyExistsError };

export class HeartbeatStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatStartupError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
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
