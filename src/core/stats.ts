// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { BaselineRecord, MetricRecord } from '../domain/types.ts';

// Metrics aggregation for `router stats`. Reports what router spent (its own codex
// tokens, and USD when priced) and, against a recorded Opus-direct baseline, what it
// offloaded/saved. Under a plan there is no per-token price and the two sides are
// different models/quota buckets, so "spent" (codex) and "offloaded" (Opus tokens
// avoided) are reported separately; net USD only when both sides are priced. PURE.

/** Averaged Opus-direct baseline (the savings denominator). */
export interface BaselineSummary {
  tokensPerTask: number;
  costUsdPerTask: number | null;
  n: number;
}

export interface Stats {
  totalRuns: number;
  verifiedRuns: number; // runs whose verifier PASSED
  // router spend
  tokensInput: number;
  tokensOutput: number;
  tokensTotal: number;
  spentUsd: number | null;
  spentUsdPerVerifiedTask: number | null;
  // quality
  firstPassRate: number | null; // of first attempts that reached a verdict
  escalationRate: number | null; // tasks whose max attempt > 1
  envErrorRuns: number;
  // savings vs the recorded Opus-direct baseline (null when no baseline)
  baselineTokensPerTask: number | null;
  baselineCostUsdPerTask: number | null;
  offloadedTokens: number | null; // Opus tokens NOT spent = baseline/task * verified
  savedUsd: number | null; // baseline USD - spent USD (only when both known)
  savedPct: number | null;
}

/** Average a baseline ledger into the denominator used for savings. */
export function summarizeBaseline(records: readonly BaselineRecord[]): BaselineSummary | null {
  if (records.length === 0) return null;
  const tokens = records.map((r) => r.tokens_input + r.tokens_output);
  const costs = records.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  return {
    tokensPerTask: sum(tokens) / records.length,
    // Only report a per-task cost if EVERY record carries one (avoid mixing).
    costUsdPerTask: costs.length === records.length ? sum(costs) / records.length : null,
    n: records.length,
  };
}

export function aggregate(
  records: readonly MetricRecord[],
  baseline: BaselineSummary | null = null,
): Stats {
  const totalRuns = records.length;
  const verifiedRuns = records.filter((r) => r.verifier_result === 'PASSED').length;

  const tokensInput = sum(records.map((r) => r.tokens_input ?? 0));
  const tokensOutput = sum(records.map((r) => r.tokens_output ?? 0));
  const tokensTotal = tokensInput + tokensOutput;

  const costs = records.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  const spentUsd = costs.length > 0 ? sum(costs) : null;
  const spentUsdPerVerifiedTask =
    spentUsd !== null && verifiedRuns > 0 ? spentUsd / verifiedRuns : null;

  const firstVerdicts = records.filter((r) => r.attempt_number === 1 && r.verifier_result !== null);
  const firstPassRate =
    firstVerdicts.length > 0
      ? firstVerdicts.filter((r) => r.verifier_result === 'PASSED').length / firstVerdicts.length
      : null;

  const maxAttemptByTask = new Map<string, number>();
  for (const r of records) {
    maxAttemptByTask.set(r.task_id, Math.max(maxAttemptByTask.get(r.task_id) ?? 0, r.attempt_number));
  }
  const escalationRate =
    maxAttemptByTask.size > 0
      ? [...maxAttemptByTask.values()].filter((n) => n > 1).length / maxAttemptByTask.size
      : null;

  const envErrorRuns = records.filter((r) => r.env_error).length;

  // Savings vs baseline (per verified task, since only verified work counts).
  const offloadedTokens =
    baseline !== null ? Math.round(baseline.tokensPerTask * verifiedRuns) : null;
  const baselineCostTotal =
    baseline !== null && baseline.costUsdPerTask !== null
      ? baseline.costUsdPerTask * verifiedRuns
      : null;
  const savedUsd =
    baselineCostTotal !== null && spentUsd !== null ? baselineCostTotal - spentUsd : null;
  const savedPct =
    savedUsd !== null && baselineCostTotal !== null && baselineCostTotal > 0
      ? savedUsd / baselineCostTotal
      : null;

  return {
    totalRuns,
    verifiedRuns,
    tokensInput,
    tokensOutput,
    tokensTotal,
    spentUsd,
    spentUsdPerVerifiedTask,
    firstPassRate,
    escalationRate,
    envErrorRuns,
    baselineTokensPerTask: baseline?.tokensPerTask ?? null,
    baselineCostUsdPerTask: baseline?.costUsdPerTask ?? null,
    offloadedTokens,
    savedUsd,
    savedPct,
  };
}

function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
