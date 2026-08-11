// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoutingReport, renderRouting, type UsageRow } from '../src/app/usageReport.ts';
import { fileURLToPath } from 'node:url';

const dirs = new Set<string>();
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    ts: '2026-07-31T12:00:00.000Z', taskId: 'task', planId: null, role: 'executor', executor: 'codex', model: 'gpt-5',
    tokensIn: 0, tokensOut: 0, tokensTotal: 0, wallSeconds: 0, costUsd: null, costSource: 'none', verifier: 'PASSED',
    attemptNumber: 1, envError: false, tier: 'strong', effort: 'medium', firstPass: true, conflict: false,
    inputTokensRecorded: 0, wallSecondsRecorded: 0, savingsUsd: 0, optimized: false,
    ...overrides,
  };
}

test('routing report groups fixed history and calculates every statistic', () => {
  const report = buildRoutingReport([
    row({ firstPass: true, attemptNumber: 1, conflict: false, wallSecondsRecorded: 10, inputTokensRecorded: 100 }),
    row({ firstPass: true, attemptNumber: 1, conflict: true, wallSecondsRecorded: 20, inputTokensRecorded: 200 }),
    row({ firstPass: true, attemptNumber: 1, conflict: false, wallSecondsRecorded: 30, inputTokensRecorded: 300 }),
    row({ firstPass: false, attemptNumber: 2, conflict: false, wallSecondsRecorded: 40, inputTokensRecorded: 400 }),
    row({ firstPass: true, attemptNumber: 2, conflict: true, wallSecondsRecorded: 50, inputTokensRecorded: 500 }),
  ]);
  const group = report.groups[0]!;
  assert.equal(group.runs, 5);
  assert.equal(group.insufficientData, false);
  assert.equal(group.firstPassRate, 0.8);
  assert.equal(group.firstPassSamples, 5);
  assert.equal(group.reDispatchRate, 0.4);
  assert.equal(group.reDispatchSamples, 5);
  assert.equal(group.conflictRate, 0.4);
  assert.equal(group.conflictSamples, 5);
  assert.equal(group.medianWallSeconds, 30);
  assert.equal(group.medianInputTokens, 300);
});

test('routing report under the threshold says insufficient data and makes no suggestion', () => {
  const report = buildRoutingReport(Array.from({ length: 4 }, () => row({ effort: 'high' })));
  assert.equal(report.groups[0]!.insufficientData, true);
  assert.deepEqual(report.suggestions, []);
  assert.match(renderRouting(report), /insufficient data \(n=4\)/);
  assert.match(renderRouting(report), /Nothing meets the threshold\./);
});

test('routing report empty history says nothing meets the threshold', () => {
  assert.match(renderRouting(buildRoutingReport([])), /Nothing meets the threshold\./);
});

test('routing suggestion cites the measured rate and sample size', () => {
  const report = buildRoutingReport(Array.from({ length: 5 }, () => row({ effort: 'high', firstPass: true })));
  assert.equal(report.suggestions.length, 1);
  assert.match(report.suggestions[0]!, /first-pass rate 100% \(n=5\)/);
});

test('usage --routing is separate from the unchanged default usage view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-usage-routing-'));
  dirs.add(dir);
  const routerDir = join(dir, '.router');
  mkdirSync(routerDir);
  // The CLI filters metrics to a rolling window from the real clock, so this row's
  // timestamp must be relative -- a fixed date ages out of the window and the test rots.
  const recentTs = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(
    join(routerDir, 'metrics.jsonl'),
    Array.from({ length: 5 }, (_, index) => JSON.stringify({
      ts: recentTs, task_id: `task-${index}`, run_id: 'run-001', attempt_number: 1,
      model: 'gpt-5', executor: 'codex', tier: 'strong', effort: 'high', conflict: false, commands_run: 1,
      exit_class: 'ok', verifier_result: 'PASSED', first_pass: true, tokens_input: 100, tokens_output: 10,
      cost_usd: null, wall_seconds: 10, escalated: false, env_error: false,
    })).join('\n') + '\n',
  );
  const output = execFileSync(process.execPath, [ENTRY, 'usage', '--router-dir', routerDir], { cwd: dir, encoding: 'utf8' });
  assert.match(output, /Router usage/);
  assert.doesNotMatch(output, /Router routing evidence/);
  const routing = JSON.parse(
    execFileSync(process.execPath, [ENTRY, 'usage', '--routing', '--json', '--router-dir', routerDir], { cwd: dir, encoding: 'utf8' }),
  ) as { routing: { groups: unknown[] } };
  assert.equal(routing.routing.groups.length, 1);
});
