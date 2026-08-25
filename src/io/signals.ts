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
