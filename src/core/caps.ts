// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { BudgetCaps, MetricRecord } from '../domain/types.ts';
import { countsAsAttempt } from './exitTaxonomy.ts';

// Budget / attempt ceilings. PURE: a function over a task's metric records + the
// configured caps -> allowed/blocked + reason. This is the deterministic guard
// that stops a task from running away; the CLI/state guard calls it before it
// allocates a new run, so the LLM never decides whether a run is permitted.

export interface CapsPolicy {
  max_attempts?: number;
  budget_caps?: BudgetCaps;
}

export interface CapsUsage {
  attemptsUsed: number; // metric records that count toward the escalation ladder
  costUsd: number; // summed provider/derived cost across the task's runs
  tokens: number; // summed input+output tokens across the task's runs
}

export interface CapsVerdict {
  allowed: boolean;
  reason?: string;
}

/** Fold a task's metric records into its accumulated attempts/cost/tokens. PURE. */
export function summarizeSpend(records: readonly MetricRecord[], taskId: string): CapsUsage {
  let attemptsUsed = 0;
  let costUsd = 0;
  let tokens = 0;
  for (const r of records) {
    if (r.task_id !== taskId) continue;
    if (countsAsAttempt(r.exit_class)) attemptsUsed += 1;
    if (r.cost_usd !== null) costUsd += r.cost_usd;
    tokens += (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
  }
  return { attemptsUsed, costUsd, tokens };
}

/**
 * Decide whether a task may start another run given its accumulated spend. A cap
 * blocks once usage has REACHED it (>=), so a task already at max_attempts cannot
 * begin another counting attempt. PURE.
 */
export function checkCaps(
  records: readonly MetricRecord[],
  taskId: string,
  caps: CapsPolicy,
): CapsVerdict {
  const usage = summarizeSpend(records, taskId);

  const maxAttempts = caps.max_attempts;
  if (maxAttempts !== undefined && usage.attemptsUsed >= maxAttempts) {
    return {
      allowed: false,
      reason: `attempt cap reached (${usage.attemptsUsed}/${maxAttempts} attempts consumed)`,
    };
  }

  const budget = caps.budget_caps;
  if (budget !== undefined) {
    if (budget.max_cost_usd !== undefined && usage.costUsd >= budget.max_cost_usd) {
      return {
        allowed: false,
        reason: `budget cap reached (cost $${usage.costUsd.toFixed(4)} >= $${budget.max_cost_usd.toFixed(4)})`,
      };
    }
    if (budget.max_tokens !== undefined && usage.tokens >= budget.max_tokens) {
      return {
        allowed: false,
        reason: `budget cap reached (${usage.tokens} tokens >= ${budget.max_tokens})`,
      };
    }
  }

  return { allowed: true };
}
