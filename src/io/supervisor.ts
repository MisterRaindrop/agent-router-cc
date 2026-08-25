// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExitClass } from '../domain/types.ts';
import { classifyExit } from '../core/exitTaxonomy.ts';
import { killProcessGroup, processGroupIsGone } from './signals.ts';

// Worker supervision. The worker is spawned as the leader of its OWN process
// group (detached) so we can kill the WHOLE group - worker + every child it
// spawned - without touching ourselves. We enforce a hard wall timeout and a
// stall watchdog (no log growth AND no worktree change), escalate SIGTERM->SIGKILL,
// and classify the exit. Worker output goes only to the log file (never our
// stdout), so the orchestrator's context stays clean.

export interface SuperviseSpec {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  heartbeatPath: string;
  /**
   * Paths whose mtime counts as "the executor is still doing something", alongside log growth.
   *
   * Explicit paths rather than a directory, because under the branch model a directory is the
   * wrong probe in both directions: editing an existing source file does not change the repo
   * root's mtime, while `.git`'s mtime moves for any git operation at all, including the
   * user's. What dispatch passes instead is the task branch's ref file -- a commit landing is
   * the executor actually finishing something, which only became a usable signal once the
   * contract started requiring one commit per functional unit.
   */
  watchPaths: readonly string[];
  maxWallMs: number;
  stallMs: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  sigkillGraceMs?: number;
  /** Called once with the worker's process-group id (== worker pid) after spawn. */
  onPgid?: (pgid: number) => void;
}

export interface SupervisionOutcome {
  exitClass: ExitClass;
  rc: number | null;
  signal: string | null;
  timedOut: boolean;
  stalled: boolean;
  spawnError: string | null;
  startedAtMs: number;
  endedAtMs: number;
  /**
   * True when the worker's process group still had members after SIGTERM *and* SIGKILL.
   *
   * The caller is about to run closeout checks and the project's own build in the same
   * checkout, so "a writer we could not stop is still in there" has to be a value it can act
   * on, not something only a comment mentions.
   */
  groupSurvived: boolean;
}

/** Poll until the group is empty, or the budget runs out. Async on purpose: the caller's event
 *  loop is idle at this point and a synchronous spin would stop the child's own `exit` events
 *  from ever being delivered. */
function waitForGroupGone(pgid: number, budgetMs: number, stepMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + budgetMs;
    const tick = (): void => {
      if (processGroupIsGone(pgid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      // NOT unref'd, and that is the whole point. The real CLI is driven by a top-level await
      // (src/index.ts); an unref'd timer does not hold the event loop open, so node exited 13
      // with the drain half-done -- no outcome, no result written, no SIGKILL sent, and the
      // child still running in the user's checkout. It only looked fine under `node --test`,
      // whose own handles kept the loop alive for us.
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/**
 * Signal the worker's whole group and do not resolve until it is actually empty.
 *
 * Resolves `true` when something survived even SIGKILL.
 */
async function drainGroup(pgid: number, graceMs: number, stepMs: number): Promise<boolean> {
  if (processGroupIsGone(pgid)) return false;
  killProcessGroup(pgid, 'SIGTERM');
  if (await waitForGroupGone(pgid, graceMs, stepMs)) return false;
  killProcessGroup(pgid, 'SIGKILL');
  if (await waitForGroupGone(pgid, graceMs, stepMs)) return false;
  return true;
}

function activitySignal(logPath: string, watchPaths: readonly string[]): number {
  let sig = 0;
  try {
    sig += statSync(logPath).size;
  } catch {
    /* not created yet */
  }
  for (const p of watchPaths) {
    try {
      sig += Math.floor(statSync(p).mtimeMs);
    } catch {
      /* not created yet -- e.g. the task branch has no commit on it so far */
    }
  }
  return sig;
}

export function superviseWorker(spec: SuperviseSpec): Promise<SupervisionOutcome> {
  const heartbeatIntervalMs = spec.heartbeatIntervalMs ?? 20_000;
  const pollIntervalMs = spec.pollIntervalMs ?? 1_000;
  const sigkillGraceMs = spec.sigkillGraceMs ?? 10_000;
  const drainPollMs = Math.max(1, Math.min(50, pollIntervalMs));

  return new Promise((resolve) => {
    mkdirSync(dirname(spec.logPath), { recursive: true });
    mkdirSync(dirname(spec.heartbeatPath), { recursive: true });
    const startedAtMs = Date.now();
    const logFd = openSync(spec.logPath, 'a');

    let timedOut = false;
    let stalled = false;
    let settled = false;
    let lastActivity = startedAtMs;
    let lastSignal = activitySignal(spec.logPath, spec.watchPaths);

    const timers: NodeJS.Timeout[] = [];
    const clearAll = (): void => {
      for (const t of timers) clearInterval(t);
      for (const t of timers) clearTimeout(t);
    };

    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      detached: true, // worker becomes its own process-group leader
      stdio: ['ignore', logFd, logFd],
    });

    const finish = (o: Omit<SupervisionOutcome, 'exitClass' | 'startedAtMs' | 'endedAtMs'>): void => {
      if (settled) return;
      settled = true;
      clearAll();
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
      const exitClass = classifyExit({
        spawnError: o.spawnError !== null,
        timedOut: o.timedOut,
        stalled: o.stalled,
        killedByUs: false,
        exitCode: o.rc,
        signal: o.signal,
      });
      resolve({ ...o, exitClass, startedAtMs, endedAtMs: Date.now() });
    };

    child.on('error', (err) => {
      // Could not launch the worker at all (e.g. codex not installed).
      finish({
        rc: null,
        signal: null,
        timedOut: false,
        stalled: false,
        spawnError: err.message,
        groupSurvived: false,
      });
    });

    child.on('exit', (code, signal) => {
      // Terminate the GROUP, not just the leader that already exited. An executor that started a
      // background compiler, server or script and then returned normally left those children
      // running: supervision reported `ok`, the caller released the exclusive lock, and the
      // survivors kept writing the same checkout. The escalation path only ran on timeout and
      // stall, so the SUCCESS path was the one that leaked.
      //
      // One SIGTERM used to be the whole of it, sent and then immediately forgotten. That is not
      // enough for the case it exists to stop: a child that INSTALLS a SIGTERM handler ignores
      // the polite request, outlives this function, and goes on writing the checkout all through
      // closeout and verification -- the caller's own SIGKILL does not arrive until verification
      // is over. So escalate here, and do not resolve while the group still has members.
      clearAll(); // the watchdogs have nothing left to watch, and a wall timer firing during the
      // drain below would turn a normal exit into a reported timeout.
      const pgid = child.pid;
      if (pgid === undefined) {
        finish({ rc: code, signal, timedOut, stalled, spawnError: null, groupSurvived: false });
        return;
      }
      void drainGroup(pgid, sigkillGraceMs, drainPollMs).then((groupSurvived) => {
        finish({ rc: code, signal, timedOut, stalled, spawnError: null, groupSurvived });
      });
    });

    const pgid = child.pid;
    if (pgid !== undefined) {
      spec.onPgid?.(pgid);

      let killing = false;
      const escalateKill = (): void => {
        if (killing) return; // run once - the stall/wall watchdogs may fire repeatedly
        killing = true;
        killProcessGroup(pgid, 'SIGTERM');
        timers.push(setTimeout(() => killProcessGroup(pgid, 'SIGKILL'), sigkillGraceMs));
      };

      // Hard wall timeout.
      timers.push(
        setTimeout(() => {
          timedOut = true;
          escalateKill();
        }, spec.maxWallMs),
      );

      // Heartbeat.
      timers.push(
        setInterval(() => {
          try {
            writeFileSync(spec.heartbeatPath, `${Date.now()}\n`);
          } catch {
            /* ignore */
          }
        }, heartbeatIntervalMs),
      );

      // Stall watchdog.
      timers.push(
        setInterval(() => {
          const sig = activitySignal(spec.logPath, spec.watchPaths);
          if (sig !== lastSignal) {
            lastSignal = sig;
            lastActivity = Date.now();
            return;
          }
          if (Date.now() - lastActivity >= spec.stallMs) {
            stalled = true;
            escalateKill();
          }
        }, pollIntervalMs),
      );

      // Initial heartbeat so recover sees a fresh file immediately.
      try {
        writeFileSync(spec.heartbeatPath, `${startedAtMs}\n`);
      } catch {
        /* ignore */
      }
    }
  });
}
