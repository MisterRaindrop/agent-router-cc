// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { MetricRecord } from '../domain/types.ts';

// Metrics aggregation for `router stats`. The headline is "cost per verified
// task" - the honest denominator the M1 exit gate is judged on. PURE.

export interface Stats {
  totalRuns: number;
  verifiedRuns: number; // runs whose verifier PASSED
  totalCostUsd: number | null;
  costPerVerifiedTask: number | null;
  firstPassRate: number | null; // of first attempts that reached a verdict
  escalationRate: number | null; // tasks whose max attempt > 1
  envErrorRuns: number;
}

export function aggregate(records: readonly MetricRecord[]): Stats {
  const totalRuns = records.length;
  const passed = records.filter((r) => r.verifier_result === 'PASSED');
  const verifiedRuns = passed.length;

  const costs = records.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? sum(costs) : null;
  const costPerVerifiedTask =
    totalCostUsd !== null && verifiedRuns > 0 ? totalCostUsd / verifiedRuns : null;

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

  return {
    totalRuns,
    verifiedRuns,
    totalCostUsd,
    costPerVerifiedTask,
    firstPassRate,
    escalationRate,
    envErrorRuns,
  };
}

function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
