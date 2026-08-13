// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  buildRoutingReport,
  buildUsageReport,
  renderRouting,
  renderUsage,
} from '../src/app/usageReport.ts';
import type { RouterPaths } from '../src/io/paths.ts';

const dirs = new Set<string>();
const NOW = '2026-08-12T12:00:00.000Z';

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

function metric(index: number, timings: Record<string, number> = {}): object {
  return {
    ts: `2026-08-12T10:00:${String(index).padStart(2, '0')}.000Z`,
    task_id: `task-${index}`,
    run_id: `run-${index}`,
    attempt_number: 1,
    model: 'gpt-5',
    executor: 'codex',
    tier: 'strong',
    effort: 'medium',
    conflict: false,
    exit_class: 'ok',
    verifier_result: 'PASSED',
    first_pass: true,
    tokens_input: 100,
    tokens_output: 10,
    cost_usd: null,
    wall_seconds: 10,
    escalated: false,
    env_error: false,
    ...timings,
  };
}

function usageWith(records: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'router-usage-timings-'));
  dirs.add(dir);
  const metrics = join(dir, 'metrics.jsonl');
  writeFileSync(metrics, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return buildUsageReport({ metrics } as unknown as RouterPaths, NOW);
}

test('routing timing medians use the middle timed row for an odd sample count', () => {
  const report = buildRoutingReport(usageWith(Array.from({ length: 5 }, (_, index) => metric(index, {
    t_worktree: index + 1,
    t_launch: (index + 1) * 2,
    t_exec: (index + 1) * 100,
    t_gate: (index + 1) * 3,
    t_verify: (index + 1) * 4,
  }))).rows);

  const group = report.groups[0]!;
  assert.equal(group.medianWorktreeSeconds, 3);
  assert.equal(group.medianLaunchSeconds, 6);
  assert.equal(group.medianExecSeconds, 300);
  assert.equal(group.medianGateSeconds, 9);
  assert.equal(group.medianVerifySeconds, 12);
  assert.equal(group.medianWorktreeSamples, 5);
  assert.equal(group.medianLaunchSamples, 5);
  assert.equal(group.medianExecSamples, 5);
  assert.equal(group.medianGateSamples, 5);
  assert.equal(group.medianVerifySamples, 5);
  assert.match(renderRouting(report), /phases: worktree 3s \(n=5\).*exec 300s \(n=5\).*verify 12s \(n=5\)/);
});

test('routing timing medians average the two middle timed rows for an even sample count', () => {
  const report = buildRoutingReport(usageWith(Array.from({ length: 6 }, (_, index) => metric(index, {
    t_worktree: index + 1,
    t_launch: index + 11,
    t_exec: index * 20,
    t_gate: index + 21,
    t_verify: index + 31,
  }))).rows);

  const group = report.groups[0]!;
  assert.equal(group.medianWorktreeSeconds, 3.5);
  assert.equal(group.medianLaunchSeconds, 13.5);
  assert.equal(group.medianExecSeconds, 50);
  assert.equal(group.medianGateSeconds, 23.5);
  assert.equal(group.medianVerifySeconds, 33.5);
  assert.equal(group.medianExecSamples, 6);
});

test('rows without phase timings still count as runs but not timing samples', () => {
  const records = [
    metric(0, { t_exec: 10 }),
    metric(1),
    metric(2, { t_exec: 30 }),
    metric(3),
    metric(4, { t_exec: 20 }),
  ];
  const group = buildRoutingReport(usageWith(records).rows).groups[0]!;

  assert.equal(group.runs, 5);
  assert.equal(group.insufficientData, false);
  assert.equal(group.medianExecSeconds, 20);
  assert.equal(group.medianExecSamples, 3);
  assert.equal(group.medianGateSeconds, null);
  assert.equal(group.medianGateSamples, 0);
});

test('a qualifying group with no phase timings renders dashes, never zero seconds', () => {
  const report = buildRoutingReport(usageWith(Array.from({ length: 5 }, (_, index) => metric(index))).rows);
  const group = report.groups[0]!;
  assert.equal(group.medianWorktreeSeconds, null);
  assert.equal(group.medianExecSeconds, null);
  assert.equal(group.medianVerifySeconds, null);

  const text = renderRouting(report);
  assert.match(text, /phases: worktree \u2014 \(n=0\)/);
  assert.match(text, /exec \u2014 \(n=0\)/);
  assert.match(text, /verify \u2014 \(n=0\)/);
  assert.doesNotMatch(text, /phases:.*0(?:\.0)?s/);
});

test('phase timing fields do not change the default usage rendering', () => {
  const untimed = renderUsage(usageWith([metric(0)]));
  const timed = renderUsage(usageWith([metric(0, {
    t_worktree: 0.1,
    t_launch: 0.05,
    t_exec: 393.2,
    t_gate: 0.08,
    t_verify: 0.03,
  })]));

  assert.equal(timed, untimed);
  assert.doesNotMatch(timed, /phases|worktree|launch|exec 393\.2s|verify/);
});
