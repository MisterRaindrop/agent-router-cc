// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname } from 'node:path';
import { killProcessGroup } from '../io/signals.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';

// `router supervise` runs one long foreground command -- a review lens, typically -- under the
// same supervisor the codex writer uses: a hard wall ceiling, a stall watchdog, the whole process
// group killed on exit, stdin closed, and output to a log file byte-for-byte as `> file 2>&1`
// would write it. The exit code passes through unchanged.
//
// It used to also publish an activity record that the statusline rendered as a live spinner.
// That display was removed in 0.15.0 with the rest of the statusline: Claude Code wakes the
// session when a background command ends, and the watchdog kills one that stalls.

// `supervise` is intentionally generic and has no contract from which to read a budget. Keep a
// real hard ceiling, but well above the review runs this command is intended for.
const MAX_WALL_MS = 24 * 60 * 60_000;
const STALL_MS = 20 * 60_000;

export interface SuperviseCommandSpec {
  logPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SuperviseCommandResult {
  exitCode: number;
  supervision: SupervisionOutcome | null;
  diagnostics: string[];
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
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

/** Run one foreground command under the supervisor, passing its exit code through. */
export async function superviseCommand(spec: SuperviseCommandSpec): Promise<SuperviseCommandResult> {
  const workerHeartbeatPath = `${spec.logPath}.heartbeat`;
  const diagnostics: string[] = [];
  const signals = bridgeTerminalSignals(diagnostics);
  try {
    if (signals.signal !== null) {
      return { exitCode: signalExitCode(signals.signal), supervision: null, diagnostics };
    }
    // `router supervise --log file` has the same overwrite semantics as `> file 2>&1`.
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
    const code = signals.signal === null ? exitCode(supervision) : signalExitCode(signals.signal);
    return { exitCode: code, supervision, diagnostics };
  } finally {
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
