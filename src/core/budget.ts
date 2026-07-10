// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { MetricRecord, RoutingObservation, WorkerKind } from '../domain/types.ts';

// Budget-aware executor routing (PURE). Under a plan there is no scriptable quota,
// so we keep a local rolling-window token ledger, estimate a task's cost, and start
// the fallback chain at the first executor with headroom instead of always the
// primary. A real provider limit (429) is still the ground-truth backstop AND the
// signal that calibrates the ceiling this code trusts. Every function here takes the
// clock as `nowMs`/`ts` inputs so it stays deterministic and unit-testable.

const DEFAULT_SWITCH_AT = 0.9;
const DEFAULT_ALPHA = 0.5;
const TRAILING_N = 20; // how many recent runs the per-task estimate averages over

function recordTokens(r: MetricRecord): number {
  return (r.tokens_input ?? 0) + (r.tokens_output ?? 0);
}

/**
 * Tokens consumed per executor within `(nowMs - windowMinutes, nowMs]`, summed from
 * metrics. Records without an `executor` or without token data are ignored.
 */
export function rollingConsumption(
  records: readonly MetricRecord[],
  nowMs: number,
  windowMinutes: number,
): Map<WorkerKind, number> {
  const floor = nowMs - windowMinutes * 60_000;
  const out = new Map<WorkerKind, number>();
  for (const r of records) {
    if (!r.executor) continue;
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t <= floor || t > nowMs) continue;
    out.set(r.executor, (out.get(r.executor) ?? 0) + recordTokens(r));
  }
  return out;
}

/**
 * Trailing-average tokens per task for `kind` (falling back to all executors, then
 * to `seed`). Only records that actually carry token data count.
 */
export function estimateTokens(
  records: readonly MetricRecord[],
  kind: WorkerKind,
  seed: number,
): number {
  const withTokens = records.filter((r) => r.tokens_input !== null || r.tokens_output !== null);
  const forKind = withTokens.filter((r) => r.executor === kind);
  const pool = forKind.length > 0 ? forKind : withTokens;
  if (pool.length === 0) return seed;
  const recent = pool.slice(-TRAILING_N);
  let sum = 0;
  for (const r of recent) sum += recordTokens(r);
  return sum / recent.length;
}

export interface RoutingBudget {
  budget_tokens: number;
  switch_at?: number;
}

export interface RoutingInput {
  /** Executor kinds in preference (fallback) order; index positions are preserved. */
  chain: readonly WorkerKind[];
  /** kind -> tokens already consumed in the window. */
  consumed: ReadonlyMap<WorkerKind, number>;
  /** kind -> projected tokens for THIS task. */
  estimates: ReadonlyMap<WorkerKind, number>;
  /** Estimate used when a kind has no entry in `estimates`. */
  defaultEstimate: number;
  /** kind -> budget. A kind with no budget is treated as unbounded (always fits). */
  budgets: ReadonlyMap<WorkerKind, RoutingBudget>;
}

export interface RoutingEntry {
  index: number; // position in the original chain
  kind: WorkerKind;
  consumed: number;
  estimate: number;
  projected: number; // consumed + estimate
  budget_tokens: number | null; // null = unbounded (no budget configured)
  fraction: number | null; // projected / budget_tokens (null when unbounded)
  fits: boolean; // fraction <= switch_at (always true when unbounded)
}

export interface RoutingDecision {
  order: number[]; // chain indices, fitting executors first (stable within each group)
  chosen: number; // order[0]; the executor the run should start with
  anyFits: boolean; // false => every budgeted executor is at/over its switch point
  entries: RoutingEntry[]; // per-chain-index detail, in original chain order
}

/**
 * Reorder the fallback chain so the run starts at the first executor with budget
 * headroom. Executors that fit keep their original relative order and come first;
 * near-ceiling executors are demoted to last-resort fallbacks (kept, so the reactive
 * 429 backstop can still use them). With no budgets configured this is the identity
 * order, i.e. plain Track-A behavior.
 */
export function selectExecutor(input: RoutingInput): RoutingDecision {
  const entries: RoutingEntry[] = input.chain.map((kind, index) => {
    const consumed = input.consumed.get(kind) ?? 0;
    const estimate = input.estimates.get(kind) ?? input.defaultEstimate;
    const projected = consumed + estimate;
    const budget = input.budgets.get(kind);
    if (budget === undefined) {
      return { index, kind, consumed, estimate, projected, budget_tokens: null, fraction: null, fits: true };
    }
    const switchAt = budget.switch_at ?? DEFAULT_SWITCH_AT;
    const fraction = projected / budget.budget_tokens;
    return {
      index,
      kind,
      consumed,
      estimate,
      projected,
      budget_tokens: budget.budget_tokens,
      fraction,
      fits: fraction <= switchAt,
    };
  });

  // Stable sort: fitting executors first, otherwise preserve chain order. When
  // nothing fits, fall back to the one with the MOST headroom (lowest fraction)
  // as a best effort rather than failing on a soft, undercounting signal.
  const anyFits = entries.some((e) => e.fits);
  const order = entries
    .map((e) => e)
    .sort((a, b) => {
      if (a.fits !== b.fits) return a.fits ? -1 : 1;
      if (!anyFits) {
        const fa = a.fraction ?? 0;
        const fb = b.fraction ?? 0;
        if (fa !== fb) return fa - fb;
      }
      return a.index - b.index;
    })
    .map((e) => e.index);

  return { order, chosen: order[0]!, anyFits, entries };
}

/**
 * Learn an executor's real ceiling from observed provider limits. For each 429
 * recorded for `kind`, the tokens consumed in the window ending at that moment are
 * the observed ceiling; we EMA the seed toward those observations and subtract a
 * safety margin. No observations => the seed is returned unchanged.
 */
export function calibrateBudget(
  seed: number,
  kind: WorkerKind,
  observations: readonly RoutingObservation[],
  metrics: readonly MetricRecord[],
  opts: { windowMinutes: number; alpha?: number; margin?: number },
): number {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const margin = opts.margin ?? 0;
  const relevant = observations
    .filter((o) => o.kind === kind)
    .map((o) => ({ o, t: Date.parse(o.ts) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);
  if (relevant.length === 0) return seed;
  let ema = seed;
  for (const { t } of relevant) {
    const ceiling = rollingConsumption(metrics, t, opts.windowMinutes).get(kind) ?? 0;
    ema = (1 - alpha) * ema + alpha * ceiling;
  }
  return Math.max(1, ema - margin);
}
