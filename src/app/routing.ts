// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { Policy, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import {
  calibrateBudget,
  estimateTokens,
  rollingConsumption,
  selectExecutor,
  type RoutingBudget,
  type RoutingDecision,
} from '../core/budget.ts';
import type { RouterPaths } from '../io/paths.ts';
import * as store from '../io/store.ts';

// Composition seam for budget-aware routing: read the io ledger (metrics + observed
// limits), calibrate each executor's ceiling, and delegate the ordering decision to
// the pure core. `_worker-run` uses `ordered`; `router routing` prints `view`.

const DEFAULT_ESTIMATE = 40_000; // per-task token seed used before any history exists

export interface EffectiveBudget {
  kind: WorkerKind;
  window_minutes: number;
  seed_tokens: number; // the policy seed
  effective_tokens: number; // after calibration from observed limits
  consumed_tokens: number; // in the current window
}

export interface RoutingView {
  budgeted: boolean; // any worker declares a budget
  decision: RoutingDecision;
  estimates: { kind: WorkerKind; tokens: number }[];
  budgets: EffectiveBudget[];
}

/**
 * Decide the order to try executors this run. With no budgets configured the pure
 * selector returns the identity order (plain fallback-chain behavior); otherwise the
 * chain is reordered to start at the first executor with window headroom.
 */
export function planExecutorOrder(
  paths: RouterPaths,
  nowMs: number,
  policy: Policy,
  workers: readonly WorkerPolicy[],
): { ordered: WorkerPolicy[]; view: RoutingView } {
  const metrics = store.readMetrics(paths);
  const observations = store.readRouting(paths);
  const seed = policy.routing?.estimate_tokens_default ?? DEFAULT_ESTIMATE;
  const chain = workers.map((w) => w.kind);

  const consumed = new Map<WorkerKind, number>();
  const budgets = new Map<WorkerKind, RoutingBudget>();
  const budgetView: EffectiveBudget[] = [];
  for (const w of workers) {
    if (w.budget === undefined) continue;
    const window_minutes = w.budget.window_minutes;
    const effective = calibrateBudget(w.budget.budget_tokens, w.kind, observations, metrics, {
      windowMinutes: window_minutes,
      ...(policy.routing?.calibration_alpha !== undefined ? { alpha: policy.routing.calibration_alpha } : {}),
      ...(policy.routing?.calibration_margin !== undefined ? { margin: policy.routing.calibration_margin } : {}),
    });
    const used = rollingConsumption(metrics, nowMs, window_minutes).get(w.kind) ?? 0;
    budgets.set(w.kind, {
      budget_tokens: effective,
      ...(w.budget.switch_at !== undefined ? { switch_at: w.budget.switch_at } : {}),
    });
    consumed.set(w.kind, used);
    budgetView.push({
      kind: w.kind,
      window_minutes,
      seed_tokens: w.budget.budget_tokens,
      effective_tokens: effective,
      consumed_tokens: used,
    });
  }

  const estimates = new Map<WorkerKind, number>();
  for (const kind of new Set(chain)) estimates.set(kind, estimateTokens(metrics, kind, seed));

  const decision = selectExecutor({ chain, consumed, estimates, defaultEstimate: seed, budgets });
  const ordered = decision.order.map((i) => workers[i]!);
  return {
    ordered,
    view: {
      budgeted: budgetView.length > 0,
      decision,
      estimates: [...estimates].map(([kind, tokens]) => ({ kind, tokens })),
      budgets: budgetView,
    },
  };
}
