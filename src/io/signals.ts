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
