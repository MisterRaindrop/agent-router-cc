// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { MetricRecord } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';
import { readJsonl } from '../io/jsonl.ts';
import { deriveBaselineCost, deriveCost, STRONG_BASELINE_MODEL } from '../core/pricing.ts';

// Builds `router usage` from .router/metrics.jsonl (one record per dispatch).
// Cost is provider-reported when present, else price-derived (an ESTIMATE from
// the project price table), else null (tokens only, never a fake $0.00).
//
// NOTE: metrics currently record DISPATCHED tasks only (codex/claude). Inline
// `worker: main` work and a spec/go "run" grouping don't exist yet, so this is a
// per-dispatch view; the richer per-run "optimized vs not + suggestions" view in
// docs/design/backlog.md lands once the go run-loop does.

const DEFAULT_DAYS = 7;
type CostSource = 'provider' | 'derived' | 'none';

export interface UsageRow {
  ts: string;
  taskId: string;
  executor: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number | null;
  costSource: CostSource;
  verifier: 'PASSED' | 'FAILED' | null;
  attemptNumber: number; // >1 means this run was a resume of the same task
  envError: boolean; // an environment/setup failure, not a task failure
  // Estimated saving vs the strong-model baseline: (tokens re-priced at baseline) minus
  // (tokens re-priced at this dispatch's own model). null if the model is unknown.
  savingsUsd: number | null;
  // Did this dispatch use a model cheaper than the strong baseline? Derived from
  // savingsUsd: >0 -> optimized; ===0 -> ran on the baseline model; null -> unknown model.
  optimized: boolean | null;
}

export interface ExecutorRollup {
  executor: string;
  dispatches: number;
  tokensTotal: number;
  costUsd: number; // sum of known (provider + derived) costs
  costComplete: boolean; // false if some rows had an unknown-model cost
}

export interface UsageReport {
  windowDays: number | null; // null = all time
  rows: UsageRow[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  totalCostUsd: number;
  costComplete: boolean; // false if any row's cost was unknown
  byExecutor: ExecutorRollup[];
  estimatedSavingsUsd: number; // sum of per-row savings vs the strong-model baseline (ESTIMATE)
  savingsComplete: boolean; // false if any row's model was unknown (savings could not be estimated)
  baselineModel: string; // the strong-model baseline savings are measured against
  suggestions: string[]; // signal-derived optimization hints (never fabricated)
}

export function buildUsageReport(paths: RouterPaths, nowIso: string, opts: { all?: boolean } = {}): UsageReport {
  const records = readJsonl<MetricRecord>(paths.metrics);
  const windowDays = opts.all ? null : DEFAULT_DAYS;
  const cutoff = windowDays === null ? -Infinity : Date.parse(nowIso) - windowDays * 86_400_000;

  const rows: UsageRow[] = [];
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && t < cutoff) continue;
    const tokensIn = r.tokens_input ?? 0;
    const tokensOut = r.tokens_output ?? 0;
    let costUsd: number | null;
    let costSource: CostSource;
    if (r.cost_usd !== null && r.cost_usd !== undefined) {
      costUsd = r.cost_usd;
      costSource = 'provider';
    } else {
      const d = deriveCost(r.model, tokensIn, tokensOut);
      costUsd = d;
      costSource = d === null ? 'none' : 'derived';
    }
    // Savings = same tokens priced at the strong baseline minus at this model's own
    // rate. Uses derived (list-price) costs on BOTH sides so it isolates the price
    // differential; null when the model is unknown (cannot derive the actual rate).
    const actualDerived = deriveCost(r.model, tokensIn, tokensOut);
    const savingsUsd = actualDerived === null ? null : Math.max(0, deriveBaselineCost(tokensIn, tokensOut) - actualDerived);
    rows.push({
      ts: r.ts,
      taskId: r.task_id,
      executor: r.executor ?? 'unknown',
      model: r.model,
      tokensIn,
      tokensOut,
      tokensTotal: tokensIn + tokensOut,
      costUsd,
      costSource,
      verifier: r.verifier_result,
      attemptNumber: r.attempt_number,
      envError: r.env_error,
      savingsUsd,
      optimized: savingsUsd === null ? null : savingsUsd > 0,
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let costComplete = true;
  let estimatedSavingsUsd = 0;
  let savingsComplete = true;
  const byExec = new Map<string, ExecutorRollup>();
  for (const row of rows) {
    totalTokensIn += row.tokensIn;
    totalTokensOut += row.tokensOut;
    if (row.costUsd === null) costComplete = false;
    else totalCostUsd += row.costUsd;
    if (row.savingsUsd === null) savingsComplete = false;
    else estimatedSavingsUsd += row.savingsUsd;

    const e =
      byExec.get(row.executor) ??
      { executor: row.executor, dispatches: 0, tokensTotal: 0, costUsd: 0, costComplete: true };
    e.dispatches += 1;
    e.tokensTotal += row.tokensTotal;
    if (row.costUsd === null) e.costComplete = false;
    else e.costUsd += row.costUsd;
    byExec.set(row.executor, e);
  }

  return {
    windowDays,
    rows,
    totalTokensIn,
    totalTokensOut,
    totalTokens: totalTokensIn + totalTokensOut,
    totalCostUsd,
    costComplete,
    byExecutor: [...byExec.values()].sort((a, b) => b.tokensTotal - a.tokensTotal),
    estimatedSavingsUsd,
    savingsComplete,
    baselineModel: STRONG_BASELINE_MODEL,
    suggestions: deriveSuggestions(rows),
  };
}

// Optimization hints derived from real signals in the dispatch history -- never
// fabricated. Groups by task (rows are newest-first, so each group's [0] is the
// latest run) and reads: did the last run fail, did it recover after a failure,
// was there an environment error, did it run on the strong baseline instead of a
// cheaper model. Returns "No waste -- healthy" when nothing warrants a hint.
export function deriveSuggestions(rows: UsageRow[]): string[] {
  if (rows.length === 0) return [];
  const byTask = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const g = byTask.get(r.taskId);
    if (g) g.push(r);
    else byTask.set(r.taskId, [r]);
  }
  const out: string[] = [];
  for (const [task, rs] of byTask) {
    const latest = rs[0]!; // newest run for this task
    const anyFailed = rs.some((r) => r.verifier === 'FAILED');
    if (rs.some((r) => r.envError)) {
      out.push(`${task}: environment error (auth/executor) -- not a task failure; fix setup`);
    }
    if (latest.verifier === 'FAILED') {
      out.push(`${task}: last run FAILED -- see \`router result ${task}\``);
    } else if (anyFailed) {
      out.push(`${task}: recovered after a failed attempt -- sharpen the contract to pass first-try`);
    }
    if (latest.optimized === false) {
      out.push(`${task} ran on the strong model -- if it's mechanical, route it to a cheaper tier next time`);
    }
  }
  if (out.length === 0) out.push('No waste -- healthy');
  return out;
}

/** The assumptions that make the savings figure an ESTIMATE, printed by `--explain-savings`. */
export function explainSavingsText(baselineModel: string): string {
  return [
    `Estimated savings = (each dispatch's tokens re-priced at the "${baselineModel}" baseline)`,
    `                    minus (the same tokens at that dispatch's own model rate).`,
    'It is an ESTIMATE at public list prices, not a measurement. Caveats:',
    `  1. Assumes the ${baselineModel} baseline would use the SAME token counts (a stronger`,
    '     model often needs fewer turns; a weaker one may retry and use more).',
    '  2. Excludes your own review/verify cost, which a baseline-only run would not incur.',
    '  3. List prices only -- real bills differ (discounts; plan auth is not billed per token).',
    '  4. Quality is unpriced: cheaper output that is worse has a cost this number cannot see.',
    'Lead with actual spend; treat savings as a rough, optimistic upper bound.',
  ].join('\n');
}

// -- rendering (English; open-source plugin) --------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtCost(costUsd: number | null, source: CostSource): string {
  if (costUsd === null) return 'tokens';
  const s = `$${costUsd.toFixed(2)}`;
  return source === 'derived' ? `~${s}` : s;
}
function shortModel(m: string | null): string {
  if (!m) return '';
  return m.length > 18 ? m.slice(0, 17) + '…' : m;
}
function optSymbol(optimized: boolean | null): string {
  return optimized === null ? '?' : optimized ? '✓' : '—';
}

export function renderUsage(report: UsageReport): string {
  const win = report.windowDays === null ? 'all time' : `last ${report.windowDays} days`;
  if (report.rows.length === 0) {
    return `Router usage — ${win}\nNo dispatches recorded yet.`;
  }
  const bar = '─'.repeat(80);
  const lines: string[] = [];
  lines.push(`Router usage — ${win}    ${report.rows.length} dispatch(es) · ${report.byExecutor.length} executor(s)`);
  lines.push(bar);
  lines.push(
    pad('Task', 16) + pad('executor/model', 28) + pad('In', 8) + pad('Out', 8) + pad('Tokens', 9) + pad('Cost', 9) + 'opt',
  );
  for (const r of report.rows) {
    const who = `${r.executor}${r.model ? `/${shortModel(r.model)}` : ''}`;
    lines.push(
      pad(r.taskId, 16) +
        pad(who, 28) +
        pad(fmtTokens(r.tokensIn), 8) +
        pad(fmtTokens(r.tokensOut), 8) +
        pad(fmtTokens(r.tokensTotal), 9) +
        pad(fmtCost(r.costUsd, r.costSource), 9) +
        optSymbol(r.optimized),
    );
  }
  lines.push(bar);
  const totalCost = report.costComplete ? `$${report.totalCostUsd.toFixed(2)}` : `~$${report.totalCostUsd.toFixed(2)}+`;
  lines.push(
    pad('TOTAL', 44) +
      pad(fmtTokens(report.totalTokensIn), 8) +
      pad(fmtTokens(report.totalTokensOut), 8) +
      pad(fmtTokens(report.totalTokens), 9) +
      totalCost,
  );
  const byExec = report.byExecutor
    .map((e) => `${e.executor} ${e.dispatches} (${e.costComplete ? '' : '~'}$${e.costUsd.toFixed(2)}${e.costComplete ? '' : '+'})`)
    .join(' · ');
  lines.push(`By executor: ${byExec}`);
  const savings = `~$${report.estimatedSavingsUsd.toFixed(2)}${report.savingsComplete ? '' : '+'}`;
  lines.push(`Estimated saved vs all-${report.baselineModel} (list price, est): ${savings}  (--explain-savings for caveats)`);
  lines.push('Cost: provider-reported where available; ~ = list-price estimate (src/core/pricing.ts); "tokens" = unknown model.');
  lines.push('opt: ✓ used a model cheaper than the baseline · — ran on the baseline model · ? unknown model.');
  if (report.suggestions.length > 0) {
    lines.push('Suggestions:');
    for (const s of report.suggestions) lines.push(`  · ${s}`);
  }
  return lines.join('\n');
}
