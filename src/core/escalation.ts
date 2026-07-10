// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { Policy, TaskState, WorkerPolicy } from '../domain/types.ts';

// The escalation ladder decision, expressed as PURE functions so the CLI/state
// machine - never the LLM - decides how a FAILED run advances. A run that fails
// climbs: retry (ESCALATED_1) -> rescue with a stronger model (ESCALATED_2) ->
// give up to the human/Opus orchestrator (NEEDS_REPLAN). No fs, no clock.

export interface LadderInput {
  /** attempt_number of the run that just failed (increments per RUNNING start). */
  attemptNumber: number;
  /** policy.escalation.max_attempts; escalation is OFF unless this is >= 2. */
  maxAttempts: number | undefined;
  /** Whether the failing exit counts as an attempt (env/quota do NOT). */
  countsAsAttempt: boolean;
}

/**
 * The state a just-FAILED task should advance to, or null to stay FAILED.
 *
 * - A non-counting failure (env_error/quota_exhausted) does NOT advance the
 *   ladder (returns null) - the attempt "did not really happen".
 * - Escalation is opt-in: with max_attempts unset or < 2 the task stays FAILED,
 *   preserving the pre-M2 "FAILED is terminal" behavior.
 * - Otherwise: attempt 1 -> ESCALATED_1 (retry), attempt >= 2 -> ESCALATED_2
 *   (rescue), and once attempts are exhausted -> NEEDS_REPLAN.
 */
export function ladderTargetAfterFailure(input: LadderInput): TaskState | null {
  const { attemptNumber, maxAttempts, countsAsAttempt } = input;
  if (!countsAsAttempt) return null;
  if (maxAttempts === undefined || maxAttempts < 2) return null;
  if (attemptNumber >= maxAttempts) return 'NEEDS_REPLAN';
  return attemptNumber <= 1 ? 'ESCALATED_1' : 'ESCALATED_2';
}

/** A run started from ESCALATED_2 is the "rescue" attempt (stronger executor). */
export function isRescueAttempt(fromState: TaskState | null): boolean {
  return fromState === 'ESCALATED_2';
}

/**
 * The executor to use for a rescue (ESCALATED_2) attempt: an explicit
 * policy.escalation.rescue_worker if set, else the LAST executor in the normal
 * chain (the strongest fallback). Undefined only if no worker is configured.
 */
export function resolveRescueWorker(policy: Policy): WorkerPolicy | undefined {
  const explicit = policy.escalation?.rescue_worker;
  if (explicit !== undefined) return explicit;
  const chain = policy.workers ?? (policy.worker !== undefined ? [policy.worker] : []);
  return chain.length > 0 ? chain[chain.length - 1] : undefined;
}
