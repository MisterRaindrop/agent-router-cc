// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveCost, priceFor } from '../src/core/pricing.ts';
import { buildUsageReport, deriveSuggestions, explainSavingsText, renderUsage } from '../src/app/usageReport.ts';
import type { RouterPaths } from '../src/io/paths.ts';

const metricsDirs = new Set<string>();

function metricsPathWith(lines: object[]): RouterPaths {
  const dir = mkdtempSync(join(tmpdir(), 'router-usage-pu1-t5-'));
  metricsDirs.add(dir);
  const metrics = join(dir, 'metrics.jsonl');
  writeFileSync(metrics, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { metrics } as unknown as RouterPaths;
}

afterEach(() => {
  for (const dir of metricsDirs) rmSync(dir, { recursive: true, force: true });
  metricsDirs.clear();
});

const NOW = '2026-07-27T00:00:00.000Z';

test('pricing: longest substring match wins (gpt-5-mini beats gpt-5)', () => {
  assert.deepEqual(priceFor('gpt-5-mini-2026'), { inPerMTok: 0.25, outPerMTok: 2 });
  assert.deepEqual(priceFor('gpt-5-codex'), { inPerMTok: 1.25, outPerMTok: 10 });
  assert.deepEqual(priceFor('claude-opus-4-8'), { inPerMTok: 5, outPerMTok: 25 });
  assert.equal(priceFor('some-unknown-model'), null);
  assert.equal(priceFor(null), null);
});

test('pricing: deriveCost = tokens × per-MTok, null for unknown model', () => {
  // gpt-5-mini: 1M in × $0.25 + 1M out × $2 = $2.25
  assert.equal(deriveCost('gpt-5-mini', 1_000_000, 1_000_000), 2.25);
  assert.equal(deriveCost('mystery', 100, 100), null);
});

test('usage report: provider cost used when present, derived when absent, null when unknown', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 't1', run_id: 'run-001', model: 'claude-opus-4-8', executor: 'claude',
      verifier_result: 'PASSED', tokens_input: 10, tokens_output: 20, cost_usd: 0.5, wall_seconds: 5 },
    { ts: '2026-07-26T01:00:00Z', task_id: 't2', run_id: 'run-001', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 5 },
    { ts: '2026-07-26T02:00:00Z', task_id: 't3', run_id: 'run-001', model: 'mystery-model', executor: 'codex',
      verifier_result: 'FAILED', tokens_input: 100, tokens_output: 100, cost_usd: null, wall_seconds: 5 },
  ]);
  const r = buildUsageReport(paths, NOW);

  assert.equal(r.rows.length, 3);
  const byTask = Object.fromEntries(r.rows.map((row) => [row.taskId, row]));
  assert.equal(byTask.t1!.costSource, 'provider');
  assert.equal(byTask.t1!.costUsd, 0.5);
  assert.equal(byTask.t1!.planId, null);
  assert.equal(byTask.t1!.role, 'executor');
  assert.equal(byTask.t1!.wallSeconds, 5);
  assert.equal(byTask.t2!.costSource, 'derived');
  assert.equal(byTask.t2!.costUsd, 2.25);
  assert.equal(byTask.t3!.costSource, 'none');
  assert.equal(byTask.t3!.costUsd, null);
  assert.deepEqual(r.plans, []); // legacy rows remain flat and are not grouped into a plan

  // total known cost = 0.5 + 2.25; costComplete false because t3's model is unknown
  assert.equal(r.totalCostUsd, 2.75);
  assert.equal(r.costComplete, false);
  // byExecutor rollup: claude 1 dispatch, codex 2 dispatches
  const codex = r.byExecutor.find((e) => e.executor === 'codex')!;
  assert.equal(codex.dispatches, 2);
  assert.equal(codex.costComplete, false); // t3 unknown
});

test('usage report: default 7-day window filters old rows; --all includes them', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'recent', run_id: 'run-001', model: 'gpt-5', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1, tokens_output: 1, cost_usd: null, wall_seconds: 1 },
    { ts: '2026-06-01T00:00:00Z', task_id: 'old', run_id: 'run-001', model: 'gpt-5', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1, tokens_output: 1, cost_usd: null, wall_seconds: 1 },
  ]);
  const windowed = buildUsageReport(paths, NOW);
  assert.deepEqual(windowed.rows.map((r) => r.taskId), ['recent']);
  assert.equal(windowed.windowDays, 7);

  const all = buildUsageReport(paths, NOW, { all: true });
  assert.equal(all.rows.length, 2);
  assert.equal(all.windowDays, null);
});

test('usage report: empty metrics renders a friendly message, not a crash', () => {
  const paths = metricsPathWith([]);
  const r = buildUsageReport(paths, NOW);
  assert.equal(r.rows.length, 0);
  const text = renderUsage(r);
  assert.match(text, /No dispatches recorded/);
});

test('savings: per-row = baseline(opus) minus own-model rate; unknown model => null/incomplete', () => {
  const paths = metricsPathWith([
    // gpt-5-mini: own = 1M*$0.25 + 1M*$2 = $2.25; opus baseline = 1M*$5 + 1M*$25 = $30 => saved $27.75
    { ts: '2026-07-26T00:00:00Z', task_id: 'cheap', run_id: 'run-001', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 1 },
    // opus itself: own == baseline => saved 0
    { ts: '2026-07-26T01:00:00Z', task_id: 'strong', run_id: 'run-001', model: 'claude-opus-4-8', executor: 'claude',
      verifier_result: 'PASSED', tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 1 },
    // unknown model => savings null => savingsComplete false
    { ts: '2026-07-26T02:00:00Z', task_id: 'mystery', run_id: 'run-001', model: 'who-knows', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 100, tokens_output: 100, cost_usd: null, wall_seconds: 1 },
  ]);
  const r = buildUsageReport(paths, NOW);
  const byTask = Object.fromEntries(r.rows.map((row) => [row.taskId, row]));
  assert.equal(byTask.cheap!.savingsUsd, 27.75);
  assert.equal(byTask.strong!.savingsUsd, 0);
  assert.equal(byTask.mystery!.savingsUsd, null);
  assert.equal(r.estimatedSavingsUsd, 27.75);
  assert.equal(r.savingsComplete, false); // mystery had no known rate
  assert.equal(r.baselineModel, 'opus');
});

test('renderUsage shows an estimated-savings line marked with ~ and est', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'cheap', run_id: 'run-001', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 1 },
  ]);
  const text = renderUsage(buildUsageReport(paths, NOW));
  assert.match(text, /Estimated saved vs all-opus/);
  assert.match(text, /~\$27\.75/);
  assert.match(text, /est/);
});

test('explainSavingsText states the baseline and the estimate caveats', () => {
  const t = explainSavingsText('opus');
  assert.match(t, /ESTIMATE/);
  assert.match(t, /opus/);
  assert.match(t, /review/i); // caveat: review cost excluded
});

test('renderUsage: includes header, TOTAL, and marks derived costs with ~', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 't2', run_id: 'run-001', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 5 },
  ]);
  const text = renderUsage(buildUsageReport(paths, NOW));
  assert.match(text, /Router usage/);
  assert.match(text, /TOTAL/);
  assert.match(text, /~\$2\.25/); // derived cost carries the ~ estimate marker
});

test('usage report: rolls up executor and orchestrator costs, savings, and real wall time by plan', () => {
  const planId = 'plan-pu1-t5-rollup';
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'exec-mini', plan_id: planId, role: 'executor',
      run_id: 'run-mini', model: 'gpt-5-mini', executor: 'codex', verifier_result: 'PASSED',
      tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 5,
      attempt_number: 1, env_error: false },
    { ts: '2026-07-26T01:00:00Z', task_id: 'exec-codex', plan_id: planId, role: 'executor',
      run_id: 'run-codex', model: 'gpt-5-codex', executor: 'codex', verifier_result: 'PASSED',
      tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 52,
      attempt_number: 1, env_error: false },
    { ts: '2026-07-26T02:00:00Z', task_id: 'exec-opus', plan_id: planId, role: 'executor',
      run_id: 'run-opus', model: 'claude-opus-4-8', executor: 'claude', verifier_result: 'PASSED',
      tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 480,
      attempt_number: 1, env_error: false },
    { ts: '2026-07-26T03:00:00Z', task_id: 'plan-main', plan_id: planId, role: 'orchestrator',
      run_id: 'orchestrator', model: 'claude-opus-4-8', executor: null, verifier_result: null,
      tokens_input: 1_000_000, tokens_output: 1_000_000, cost_usd: null, wall_seconds: 537,
      attempt_number: 1, env_error: false },
  ]);

  const report = buildUsageReport(paths, NOW);
  assert.equal(report.plans.length, 1);
  const plan = report.plans[0]!;
  assert.equal(plan.planId, planId);
  assert.deepEqual(plan.executorRows.map((row) => row.taskId), ['exec-opus', 'exec-codex', 'exec-mini']);
  assert.equal(plan.orchestrator?.taskId, 'plan-main');
  assert.equal(plan.executorCostUsd, 43.5);
  assert.equal(plan.orchestratorCostUsd, 30);
  assert.equal(plan.actualTotalUsd, 73.5);
  assert.equal(plan.savedUsd, 46.5);
  assert.equal(plan.allBaselineUsd, 120);
  assert.equal(plan.wallSecondsExecutors, 537);
  assert.equal(plan.orchestratorMeasured, true);
  assert.equal(plan.costComplete, true);

  const text = renderUsage(report);
  assert.match(text, /By plan:/);
  assert.match(text, /exec-mini .* wall 5s/);
  assert.match(text, /orchestrator \(opus, main, approx\):/);
  assert.match(text, /execution wall: 8\.9m/);
});

test('usage report: plan without an orchestrator says the main model was not measured', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'execution-only', plan_id: 'plan-pu1-t5-execution-only',
      role: 'executor', run_id: 'run-only', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1000, tokens_output: 1000, cost_usd: null,
      wall_seconds: 61, attempt_number: 1, env_error: false },
  ]);

  const report = buildUsageReport(paths, NOW);
  assert.equal(report.plans.length, 1);
  assert.equal(report.plans[0]!.orchestrator, null);
  assert.equal(report.plans[0]!.orchestratorMeasured, false);
  assert.match(
    renderUsage(report),
    /orchestrator \(main model\): not measured — comparison is execution-side only/,
  );
});

test('optimized: savings>0 => ✓, savings===0 => not, unknown model => null', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'cheap', run_id: 'run-001', model: 'gpt-5-mini', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 1000, tokens_output: 1000, cost_usd: null, wall_seconds: 1, attempt_number: 1, env_error: false },
    { ts: '2026-07-26T01:00:00Z', task_id: 'strong', run_id: 'run-001', model: 'claude-opus-4-8', executor: 'claude',
      verifier_result: 'PASSED', tokens_input: 1000, tokens_output: 1000, cost_usd: null, wall_seconds: 1, attempt_number: 1, env_error: false },
    { ts: '2026-07-26T02:00:00Z', task_id: 'mystery', run_id: 'run-001', model: 'who-knows', executor: 'codex',
      verifier_result: 'PASSED', tokens_input: 100, tokens_output: 100, cost_usd: null, wall_seconds: 1, attempt_number: 1, env_error: false },
  ]);
  const byTask = Object.fromEntries(buildUsageReport(paths, NOW).rows.map((r) => [r.taskId, r]));
  assert.equal(byTask.cheap!.optimized, true);
  assert.equal(byTask.strong!.optimized, false);
  assert.equal(byTask.mystery!.optimized, null);
});

test('deriveSuggestions reads real signals (fail / recover / strong-model / env / healthy)', () => {
  const row = (over: Partial<Parameters<typeof deriveSuggestions>[0][number]>) => ({
    ts: 't', taskId: 'x', planId: null, role: 'executor' as const, executor: 'codex', model: 'm',
    tokensIn: 0, tokensOut: 0, tokensTotal: 0, wallSeconds: 0, costUsd: null,
    costSource: 'none' as const, verifier: 'PASSED' as const, attemptNumber: 1, envError: false,
    savingsUsd: 1, optimized: true, ...over,
  });
  assert.deepEqual(deriveSuggestions([]), []); // no dispatches -> no hints
  // latest FAILED
  assert.ok(deriveSuggestions([row({ taskId: 'a', verifier: 'FAILED' })]).some((s) => /a: last run FAILED/.test(s)));
  // recovered: newest PASSED, older FAILED (rows are newest-first)
  const recovered = deriveSuggestions([row({ taskId: 'b', verifier: 'PASSED' }), row({ taskId: 'b', verifier: 'FAILED' })]);
  assert.ok(recovered.some((s) => /b: recovered after a failed attempt/.test(s)));
  // strong-model (optimized false)
  assert.ok(deriveSuggestions([row({ taskId: 'c', optimized: false })]).some((s) => /c ran on the strong model/.test(s)));
  // env error
  assert.ok(deriveSuggestions([row({ taskId: 'd', envError: true })]).some((s) => /d: environment error/.test(s)));
  // all clean -> healthy
  assert.deepEqual(deriveSuggestions([row({ taskId: 'e' })]), ['No waste -- healthy']);

  // The orchestrator row is never a routing suggestion: it IS the main model, so
  // "route it to a cheaper tier" names the one row that cannot be routed. Measured on a
  // real plan, that is exactly what the report said, next to hints that were correct.
  const orchestrator = row({
    taskId: 'issue-42/orchestrator',
    role: 'orchestrator' as const,
    optimized: false,
    verifier: null,
  });
  assert.deepEqual(deriveSuggestions([orchestrator]), ['No waste -- healthy']);
  // ...and it must not suppress a real hint from an executor row alongside it.
  const mixed = deriveSuggestions([orchestrator, row({ taskId: 'f', optimized: false })]);
  assert.ok(mixed.some((s) => /f ran on the strong model/.test(s)));
  assert.ok(!mixed.some((s) => /orchestrator/.test(s)), mixed.join(' | '));
});

test('renderUsage shows the opt column and a Suggestions section', () => {
  const paths = metricsPathWith([
    { ts: '2026-07-26T00:00:00Z', task_id: 'strong', run_id: 'run-001', model: 'claude-opus-4-8', executor: 'claude',
      verifier_result: 'PASSED', tokens_input: 1000, tokens_output: 1000, cost_usd: 1, wall_seconds: 1, attempt_number: 1, env_error: false },
  ]);
  const text = renderUsage(buildUsageReport(paths, NOW));
  assert.match(text, /opt/); // column header + legend
  assert.match(text, /Suggestions:/);
  assert.match(text, /strong ran on the strong model/); // opus dispatch -> route-cheaper hint
});
