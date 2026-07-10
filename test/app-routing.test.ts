// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPaths } from '../src/io/paths.ts';
import * as store from '../src/io/store.ts';
import { planExecutorOrder } from '../src/app/routing.ts';
import type { MetricRecord, Policy } from '../src/domain/types.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-routing-'));

function metric(over: Partial<MetricRecord>): MetricRecord {
  return {
    ts: at(0), task_id: 't', run_id: 'run-001', attempt_number: 1, model: null, executor: 'codex',
    exit_class: 'ok', verifier_result: 'PASSED', first_pass: true, tokens_input: 0, tokens_output: 0,
    cost_usd: null, wall_seconds: 1, escalated: false, env_error: false, ...over,
  };
}

const policy = (workers: Policy['workers'], routing?: Policy['routing']): Policy => ({
  schema_version: 1,
  scope: { max_changed_lines: 100 },
  verification: { build: [['x']], test: [['y']] },
  ...(workers !== undefined ? { workers } : {}),
  ...(routing !== undefined ? { routing } : {}),
});

test('planExecutorOrder: no budgets => identity order (Track-A behavior)', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    const pol = policy([{ kind: 'codex' }, { kind: 'claude' }]);
    const { ordered, view } = planExecutorOrder(p, T0, pol, pol.workers!);
    assert.deepEqual(ordered.map((w) => w.kind), ['codex', 'claude']);
    assert.equal(view.budgeted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planExecutorOrder: skips the over-budget primary using the rolling ledger', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    // codex already burned 960 tokens in the last hour.
    store.appendMetric(p, metric({ ts: at(30 * MIN), executor: 'codex', tokens_input: 960 }));
    const pol = policy(
      [
        { kind: 'codex', budget: { window_minutes: 300, budget_tokens: 1000, switch_at: 0.9 } },
        { kind: 'claude', budget: { window_minutes: 300, budget_tokens: 1000 } },
      ],
      { estimate_tokens_default: 50 },
    );
    const now = T0 + 60 * MIN;
    const { ordered, view } = planExecutorOrder(p, now, pol, pol.workers!);
    // codex projected 960+50 = 1010 (>90% of 1000) => demoted; claude leads.
    assert.deepEqual(ordered.map((w) => w.kind), ['claude', 'codex']);
    assert.equal(view.budgeted, true);
    const codex = view.decision.entries.find((e) => e.kind === 'codex')!;
    assert.equal(codex.fits, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planExecutorOrder: a calibrated (lowered) ceiling changes the decision', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    // History: codex has consumed 700 tokens in the window.
    store.appendMetric(p, metric({ ts: at(30 * MIN), executor: 'codex', tokens_input: 700 }));
    // A real 429 was recorded for codex at +40min (when its window consumption was 700).
    store.appendRouting(p, { ts: at(40 * MIN), kind: 'codex', task_id: 't', run_id: 'run-001' });
    // Seed ceiling is a generous 5000, but alpha=1 calibrates it straight to 700.
    const pol = policy(
      [
        { kind: 'codex', budget: { window_minutes: 300, budget_tokens: 5000, switch_at: 0.9 } },
        { kind: 'claude', budget: { window_minutes: 300, budget_tokens: 5000 } },
      ],
      { estimate_tokens_default: 50, calibration_alpha: 1 },
    );
    const now = T0 + 60 * MIN;
    const { ordered, view } = planExecutorOrder(p, now, pol, pol.workers!);
    const codexBudget = view.budgets.find((b) => b.kind === 'codex')!;
    assert.equal(codexBudget.effective_tokens, 700); // learned from the 429, not the 5000 seed
    // Against the learned 700 ceiling, 700+50 = 750 is >90% => codex demoted.
    assert.deepEqual(ordered.map((w) => w.kind), ['claude', 'codex']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
