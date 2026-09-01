// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Process-group signalling. Killing the GROUP (negative pid) reaches the worker
// and every child it spawned. Used by recover (kill an abandoned group) and by
// the supervisor (SIGTERM->SIGKILL escalation).
export type KillSignal = NodeJS.Signals | number;

/**
 * Signal an entire process group. Returns true if the signal was delivered,
 * false if the group no longer exists / we lack permission. Never throws for
 * the common "already gone" cases.
 */
export function killProcessGroup(pgid: number, signal: KillSignal): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false; // never touch pgid 0/1
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw err;
  }
}

/**
 * Whether a process group has no members left.
 *
 * `EPERM` deliberately reads as "still there": the group exists but is not ours to signal, and
 * treating that as gone is exactly the "two writers, one checkout" mistake this guards against.
 *
 * One nuance, in case this ever looks like a bug: a SIGKILLed process still answers signal 0
 * while it is a zombie, i.e. until its parent reaps it. That does not affect the processes this
 * is aimed at -- an orphaned executor's parent is the router that died, so it has already been
 * reparented to init, which reaps immediately; and a supervised worker fires its `exit` event
 * only after Node itself has reaped it. A caller that is *itself* the survivor's parent and
 * never returns to its event loop would see a zombie answer here forever.
 */
export function processGroupIsGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Block this thread for `ms`.
 *
 * Only for callers that are synchronous by construction. Every one of them has already frozen the
 * event loop with `spawnSync` or is inside a CLI step that must not yield, so there is no loop left
 * to hand control back to and a promise here would never be resolved.
 */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface DrainOutcome {
  /** What emptied the group. Absent when it was already empty on arrival. */
  signal?: 'SIGTERM' | 'SIGKILL';
  /** Something outlived SIGKILL. The caller may NOT treat the workspace as quiet. */
  survived: boolean;
}

/**
 * Signal a process group and do not return until it is empty: SIGTERM, wait, SIGKILL, wait.
 *
 * The synchronous twin of `drainGroup` in io/supervisor.ts, and synchronous for the opposite
 * reason that one is async: the supervisor has an idle event loop to poll on, while every caller
 * here has already blocked it with `spawnSync`.
 *
 * `onPoll` runs once per tick, for a caller that holds a lease it must keep renewing while this
 * loop -- the slow part -- runs.
 */
export function drainGroupSync(
  pgid: number,
  graceMs: number,
  onPoll: () => void = () => {},
  stepMs = 50,
): DrainOutcome {
  if (!Number.isInteger(pgid) || pgid <= 1) return { survived: false };
  if (processGroupIsGone(pgid)) return { survived: false };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    killProcessGroup(pgid, signal);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (processGroupIsGone(pgid)) return { signal, survived: false };
      sleepSync(stepMs);
      onPoll();
    }
  }
  return { survived: true };
}
