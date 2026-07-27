// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { MetricRecord } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';
import { readJsonl } from '../io/jsonl.ts';
import { deriveCost } from '../core/pricing.ts';

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
    });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let costComplete = true;
  const byExec = new Map<string, ExecutorRollup>();
  for (const row of rows) {
    totalTokensIn += row.tokensIn;
    totalTokensOut += row.tokensOut;
    if (row.costUsd === null) costComplete = false;
    else totalCostUsd += row.costUsd;

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
  };
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

export function renderUsage(report: UsageReport): string {
  const win = report.windowDays === null ? 'all time' : `last ${report.windowDays} days`;
  if (report.rows.length === 0) {
    return `Router usage — ${win}\nNo dispatches recorded yet.`;
  }
  const bar = '─'.repeat(80);
  const lines: string[] = [];
  lines.push(`Router usage — ${win}    ${report.rows.length} dispatch(es) · ${report.byExecutor.length} executor(s)`);
  lines.push(bar);
  lines.push(pad('Task', 16) + pad('executor/model', 28) + pad('In', 8) + pad('Out', 8) + pad('Tokens', 9) + 'Cost');
  for (const r of report.rows) {
    const who = `${r.executor}${r.model ? `/${shortModel(r.model)}` : ''}`;
    lines.push(
      pad(r.taskId, 16) +
        pad(who, 28) +
        pad(fmtTokens(r.tokensIn), 8) +
        pad(fmtTokens(r.tokensOut), 8) +
        pad(fmtTokens(r.tokensTotal), 9) +
        fmtCost(r.costUsd, r.costSource),
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
  lines.push('Cost: provider-reported where available; ~ = list-price estimate (src/core/pricing.ts); "tokens" = unknown model.');
  return lines.join('\n');
}
