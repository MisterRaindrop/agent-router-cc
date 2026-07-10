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

/** Neither an env error nor a provider quota hit counts toward the escalation ladder. */
export function countsAsAttempt(exitClass: ExitClass): boolean {
  return exitClass !== 'env_error' && exitClass !== 'quota_exhausted';
}

// Default signatures for a provider rate-limit / quota exhaustion in the worker log.
// Conservative so ordinary failures (a failing test, `exit 1`) are NOT reclassified.
export const DEFAULT_QUOTA_PATTERN =
  '\\b(rate.?limit|rate_limited|usage limit|usage_limit_reached|quota|insufficient_quota|too many requests|429)\\b';

/**
 * A worker that "failed" may actually have hit the provider's quota/rate limit.
 * If the exit looks like a plain failure/crash AND the log matches the quota
 * pattern, reclassify as quota_exhausted (so it triggers fallback, not an attempt).
 * PURE.
 */
export function reclassifyQuota(
  exitClass: ExitClass,
  logText: string,
  pattern: string = DEFAULT_QUOTA_PATTERN,
): ExitClass {
  if (exitClass !== 'task_failed' && exitClass !== 'worker_crash') return exitClass;
  return new RegExp(pattern, 'i').test(logText) ? 'quota_exhausted' : exitClass;
}
