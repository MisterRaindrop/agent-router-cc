// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { ExitClass } from '../domain/types.ts';

// Classify how a worker run ended. env_error is deliberately its own class: it
// means the environment was wrong (codex missing, auth absent) rather than the
// task failing, and the escalation ladder must NOT count it as an attempt. PURE.

export interface SupervisionObservation {
  spawnError: boolean; // the worker binary couldn't be launched
  timedOut: boolean; // we killed it for exceeding max_wall
  stalled: boolean; // we killed it for making no progress
  killedByUs: boolean; // external cancel
  exitCode: number | null;
  signal: string | null; // signal it died from (if any)
}

export function classifyExit(o: SupervisionObservation): ExitClass {
  if (o.spawnError) return 'env_error';
  if (o.timedOut) return 'timeout';
  if (o.stalled) return 'stalled';
  if (o.killedByUs) return 'killed';
  if (o.signal !== null) return 'worker_crash';
  if (o.exitCode === 0) return 'ok';
  return 'task_failed';
}

/** env_error does not count toward the escalation ladder (design F2.1). */
export function countsAsAttempt(exitClass: ExitClass): boolean {
  return exitClass !== 'env_error';
}
