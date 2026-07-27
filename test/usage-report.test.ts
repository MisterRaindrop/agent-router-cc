// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveCost, priceFor } from '../src/core/pricing.ts';
import { buildUsageReport, renderUsage } from '../src/app/usageReport.ts';
import type { RouterPaths } from '../src/io/paths.ts';

function metricsPathWith(lines: object[]): RouterPaths {
  const dir = mkdtempSync(join(tmpdir(), 'router-usage-'));
  const metrics = join(dir, 'metrics.jsonl');
  writeFileSync(metrics, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { metrics } as unknown as RouterPaths;
}

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
  assert.equal(byTask.t2!.costSource, 'derived');
  assert.equal(byTask.t2!.costUsd, 2.25);
  assert.equal(byTask.t3!.costSource, 'none');
  assert.equal(byTask.t3!.costUsd, null);

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
