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
  planId: string | null;
  role: 'executor' | 'orchestrator';
  executor: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  wallSeconds: number;
  costUsd: number | null;
  costSource: CostSource;
  verifier: 'PASSED' | 'FAILED' | null;
  attemptNumber: number | null; // >1 means this run was a resume of the same task
  envError: boolean; // an environment/setup failure, not a task failure
  // Routing fields were added after the original usage history. Keep absent
  // values absent so the routing view never turns missing history into a rate.
  tier?: string | null;
  effort?: string | null;
  firstPass?: boolean | null;
  conflict?: boolean | null;
  inputTokensRecorded?: number | null;
  wallSecondsRecorded?: number | null;
  // Estimated saving vs the strong-model baseline: (tokens re-priced at baseline) minus
  // (tokens re-priced at this dispatch's own model). null if the model is unknown.
  savingsUsd: number | null;
  // Did this dispatch use a model cheaper than the strong baseline? Derived from
  // savingsUsd: >0 -> optimized; ===0 -> ran on the baseline model; null -> unknown model.
  optimized: boolean | null;
}

/** A floor for honesty, not a statistical claim. */
export const ROUTING_MINIMUM_RUNS = 5;

export interface RoutingGroup {
  executor: string;
  tier: string | null;
  effort: string | null;
  runs: number;
  insufficientData: boolean;
  firstPassRate: number | null;
  firstPassSamples: number;
  reDispatchRate: number | null;
  reDispatchSamples: number;
  conflictRate: number | null;
  conflictSamples: number;
  medianWallSeconds: number | null;
  medianWallSamples: number;
  medianInputTokens: number | null;
  medianInputSamples: number;
}

export interface RoutingReport {
  groups: RoutingGroup[];
  suggestions: string[];
}

export interface ExecutorRollup {
  executor: string;
  dispatches: number;
  tokensTotal: number;
  costUsd: number; // sum of known (provider + derived) costs
  costComplete: boolean; // false if some rows had an unknown-model cost
}

export interface PlanRollup {
  planId: string;
  executorRows: UsageRow[];
  orchestrator: UsageRow | null;
  executorCostUsd: number;
  orchestratorCostUsd: number;
  actualTotalUsd: number;
  savedUsd: number;
  allBaselineUsd: number;
  wallSecondsExecutors: number;
  orchestratorMeasured: boolean;
  costComplete: boolean;
}

export interface UsageReport {
  windowDays: number | null; // null = all time
  rows: UsageRow[];
  plans: PlanRollup[];
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
      planId: r.plan_id ?? null,
      role: r.role ?? 'executor',
      executor: r.executor ?? 'unknown',
      model: r.model,
      tokensIn,
      tokensOut,
      tokensTotal: tokensIn + tokensOut,
      wallSeconds: r.wall_seconds ?? 0,
      costUsd,
      costSource,
      verifier: r.verifier_result,
      attemptNumber: r.attempt_number ?? null,
      envError: r.env_error,
      tier: r.tier ?? null,
      effort: r.effort ?? null,
      firstPass: typeof r.first_pass === 'boolean' ? r.first_pass : null,
      conflict: typeof r.conflict === 'boolean' ? r.conflict : null,
      inputTokensRecorded: r.tokens_input,
      wallSecondsRecorded: typeof r.wall_seconds === 'number' ? r.wall_seconds : null,
      savingsUsd,
      optimized: savingsUsd === null ? null : savingsUsd > 0,
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first

  const byPlan = new Map<string, Pick<PlanRollup, 'planId' | 'executorRows' | 'orchestrator'>>();
  for (const row of rows) {
    if (row.planId === null) continue;
    const plan = byPlan.get(row.planId) ?? { planId: row.planId, executorRows: [], orchestrator: null };
    if (row.role === 'orchestrator') {
      // Metrics contain at most one orchestrator row per plan. Keep the newest
      // if malformed input contains more than one (rows are newest-first).
      if (plan.orchestrator === null) plan.orchestrator = row;
    } else {
      plan.executorRows.push(row);
    }
    byPlan.set(row.planId, plan);
  }
  const plans: PlanRollup[] = [...byPlan.values()].map((plan) => {
    let executorCostUsd = 0;
    let savedUsd = 0;
    let wallSecondsExecutors = 0;
    let costComplete = true;
    for (const row of plan.executorRows) {
      if (row.costUsd === null) costComplete = false;
      else executorCostUsd += row.costUsd;
      if (row.savingsUsd === null) costComplete = false;
      else savedUsd += row.savingsUsd;
      wallSecondsExecutors += row.wallSeconds;
    }
    const orchestratorCostUsd = plan.orchestrator?.costUsd ?? 0;
    const actualTotalUsd = executorCostUsd + orchestratorCostUsd;
    return {
      ...plan,
      executorCostUsd,
      orchestratorCostUsd,
      actualTotalUsd,
      savedUsd,
      allBaselineUsd: actualTotalUsd + savedUsd,
      wallSecondsExecutors,
      orchestratorMeasured: plan.orchestrator !== null,
      costComplete,
    };
  });

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
    plans,
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

// Routing evidence is deliberately independent of the ordinary usage report:
// it reads only values present in recorded rows and never alters configuration.
export function buildRoutingReport(rows: UsageRow[]): RoutingReport {
  const grouped = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.executor, row.tier, row.effort]);
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }

  const groups = [...grouped.values()].map((group): RoutingGroup => {
    const firstPass = group.flatMap((row) => (typeof row.firstPass === 'boolean' ? [row.firstPass] : []));
    const reDispatch = group.flatMap((row) => (row.attemptNumber == null ? [] : [row.attemptNumber > 1]));
    const conflict = group.flatMap((row) => (typeof row.conflict === 'boolean' ? [row.conflict] : []));
    const wall = group.flatMap((row) => (row.wallSecondsRecorded == null ? [] : [row.wallSecondsRecorded]));
    const input = group.flatMap((row) => (row.inputTokensRecorded == null ? [] : [row.inputTokensRecorded]));
    const insufficientData = group.length < ROUTING_MINIMUM_RUNS;
    return {
      executor: group[0]!.executor,
      tier: group[0]!.tier ?? null,
      effort: group[0]!.effort ?? null,
      runs: group.length,
      insufficientData,
      firstPassRate: insufficientData ? null : rate(firstPass),
      firstPassSamples: insufficientData ? 0 : firstPass.length,
      reDispatchRate: insufficientData ? null : rate(reDispatch),
      reDispatchSamples: insufficientData ? 0 : reDispatch.length,
      conflictRate: insufficientData ? null : rate(conflict),
      conflictSamples: insufficientData ? 0 : conflict.length,
      medianWallSeconds: insufficientData ? null : median(wall),
      medianWallSamples: insufficientData ? 0 : wall.length,
      medianInputTokens: insufficientData ? null : median(input),
      medianInputSamples: insufficientData ? 0 : input.length,
    };
  });
  groups.sort((a, b) => a.executor.localeCompare(b.executor) || String(a.tier).localeCompare(String(b.tier)) || String(a.effort).localeCompare(String(b.effort)));
  return { groups, suggestions: deriveRoutingSuggestions(groups) };
}

function rate(values: boolean[]): number | null {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function isAboveMedium(effort: string | null | undefined): boolean {
  return typeof effort === 'string' && ['high', 'xhigh', 'max', 'ultra'].includes(effort.toLowerCase());
}

function describeGroup(group: RoutingGroup): string {
  return `${group.executor}/${group.tier ?? 'unrecorded tier'}/${group.effort ?? 'unrecorded effort'}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function deriveRoutingSuggestions(groups: RoutingGroup[]): string[] {
  const suggestions: string[] = [];
  for (const group of groups) {
    if (group.insufficientData || group.firstPassRate === null || !isAboveMedium(group.effort)) continue;
    if (group.firstPassRate >= 0.9) {
      suggestions.push(`${describeGroup(group)}: first-pass rate ${percent(group.firstPassRate)} (n=${group.firstPassSamples}) at ${group.effort} effort; it may be worth lowering effort.`);
    }
  }
  for (const group of groups) {
    if (suggestions.length >= 3) break;
    if (group.insufficientData || group.reDispatchRate === null || group.reDispatchRate < 0.3) continue;
    suggestions.push(`${describeGroup(group)}: re-dispatch rate ${percent(group.reDispatchRate)} (n=${group.reDispatchSamples}); it may be worth raising the tier or effort.`);
  }
  return suggestions.slice(0, 3);
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
function fmtWall(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : `${(seconds / 60).toFixed(1)}m`;
}
function fmtCost(costUsd: number | null, source: CostSource): string {
  if (costUsd === null) return 'tokens';
  const s = `$${costUsd.toFixed(2)}`;
  return source === 'derived' ? `~${s}` : s;
}
function fmtAggregateCost(costUsd: number, rows: UsageRow[], complete: boolean): string {
  const estimated = !complete || rows.some((row) => row.costSource === 'derived');
  return `${estimated ? '~' : ''}$${costUsd.toFixed(2)}${complete ? '' : '+'}`;
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
  if (report.plans.length > 0) {
    lines.push(bar);
    lines.push('By plan:');
    for (const plan of report.plans) {
      lines.push(`  Plan ${plan.planId}`);
      for (const row of plan.executorRows) {
        lines.push(
          `    ${row.taskId} · ${row.model ?? 'unknown model'} · in ${fmtTokens(row.tokensIn)} · out ${fmtTokens(row.tokensOut)} · ${fmtCost(row.costUsd, row.costSource)} · wall ${fmtWall(row.wallSeconds)}`,
        );
      }
      const executorTokens = plan.executorRows.reduce((sum, row) => sum + row.tokensTotal, 0);
      lines.push(
        `    executors: ${plan.executorRows.length} · ${fmtTokens(executorTokens)} · ${fmtAggregateCost(plan.executorCostUsd, plan.executorRows, plan.costComplete)}`,
      );
      if (plan.orchestrator !== null) {
        lines.push(
          `    orchestrator (${report.baselineModel}, main, approx): ${fmtTokens(plan.orchestrator.tokensTotal)} · ${fmtCost(plan.orchestrator.costUsd, plan.orchestrator.costSource)}`,
        );
      } else {
        lines.push('    orchestrator (main model): not measured — comparison is execution-side only');
      }
      const actualRows = plan.orchestrator === null ? plan.executorRows : [...plan.executorRows, plan.orchestrator];
      const actualCostComplete = plan.costComplete && (plan.orchestrator?.costUsd !== null);
      lines.push(
        `    actual total: ${fmtAggregateCost(plan.actualTotalUsd, actualRows, actualCostComplete)} ; if all on ${report.baselineModel} (est): ~$${plan.allBaselineUsd.toFixed(2)}${plan.costComplete ? '' : '+'} ; saved (est): ~$${plan.savedUsd.toFixed(2)}${plan.costComplete ? '' : '+'}`,
      );
      lines.push(`    execution wall: ${fmtWall(plan.wallSecondsExecutors)}`);
    }
  }
  return lines.join('\n');
}

function routingLabel(value: string | null, missing: string): string {
  return value ?? missing;
}

function routingRate(label: string, value: number | null, samples: number): string {
  return value === null ? `${label} unavailable` : `${label} ${percent(value)} (n=${samples})`;
}

function routingMedian(label: string, value: number | null, samples: number, format: (n: number) => string): string {
  return value === null ? `${label} unavailable` : `${label} ${format(value)} (n=${samples})`;
}

export function renderRouting(report: RoutingReport): string {
  const lines = ['Router routing evidence'];
  if (report.groups.length === 0) {
    lines.push('Nothing meets the threshold.');
    return lines.join('\n');
  }
  lines.push('executor/tier/effort                 runs  first pass             re-dispatch            conflict               median wall          median input');
  for (const group of report.groups) {
    const label = `${routingLabel(group.executor, 'unknown')}/${routingLabel(group.tier, 'unrecorded')}/${routingLabel(group.effort, 'unrecorded')}`;
    if (group.insufficientData) {
      lines.push(`${pad(label, 36)}${pad(`insufficient data (n=${group.runs})`, 0)}`);
      continue;
    }
    lines.push(
      pad(label, 36) +
        pad(String(group.runs), 6) +
        pad(routingRate('first-pass', group.firstPassRate, group.firstPassSamples), 23) +
        pad(routingRate('re-dispatch', group.reDispatchRate, group.reDispatchSamples), 23) +
        pad(routingRate('conflict', group.conflictRate, group.conflictSamples), 23) +
        pad(routingMedian('wall', group.medianWallSeconds, group.medianWallSamples, fmtWall), 21) +
        routingMedian('input', group.medianInputTokens, group.medianInputSamples, fmtTokens),
    );
  }
  if (!report.groups.some((group) => !group.insufficientData)) {
    lines.push('Nothing meets the threshold.');
    return lines.join('\n');
  }
  if (report.suggestions.length > 0) {
    lines.push('Suggestions:');
    for (const suggestion of report.suggestions) lines.push(`  · ${suggestion}`);
  }
  return lines.join('\n');
}
