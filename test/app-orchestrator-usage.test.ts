// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordOrchestratorUsage } from '../src/app/orchestratorUsage.ts';
import { deriveCost } from '../src/core/pricing.ts';
import type { MetricRecord } from '../src/domain/types.ts';
import { fixedClock } from '../src/io/clock.ts';
import { readJsonl } from '../src/io/jsonl.ts';
import { routerPaths } from '../src/io/paths.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-session.jsonl', import.meta.url));
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const SINCE = '2026-07-24T14:21:02.633Z';
const UNTIL = '2026-07-24T14:30:00.000Z';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-orchestrator-usage-'));

test('recordOrchestratorUsage appends one orchestrator metric with transcript totals', () => {
  const dir = tmp();
  try {
    const paths = routerPaths(join(dir, '.router'));
    const result = recordOrchestratorUsage(paths, fixedClock(UNTIL), {
      planId: 'plan-7',
      sinceIso: SINCE,
      untilIso: UNTIL,
      transcriptPath: FIXTURE,
      model: 'opus',
    });
    if (!result.recorded) assert.fail(`usage was not recorded: ${result.reason}`);

    const expectedCost = deriveCost('opus', 77, 14);
    if (expectedCost === null) assert.fail('opus should have a configured price');
    assert.equal(result.inputTokens, 77);
    assert.equal(result.outputTokens, 14);
    assert.ok(Math.abs((result.cost_usd ?? Number.NaN) - expectedCost) < 1e-12);

    const metrics = readJsonl<MetricRecord>(paths.metrics);
    assert.equal(metrics.length, 1);
    assert.deepEqual(metrics[0], {
      ts: UNTIL,
      task_id: 'plan-7/orchestrator',
      plan_id: 'plan-7',
      role: 'orchestrator',
      run_id: 'orchestrator',
      attempt_number: 1,
      model: 'opus',
      exit_class: 'ok',
      verifier_result: null,
      first_pass: true,
      tokens_input: 77,
      tokens_output: 14,
      cost_usd: expectedCost,
      wall_seconds: 537,
      escalated: false,
      env_error: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordOrchestratorUsage degrades without appending when no turns match', () => {
  const dir = tmp();
  try {
    const paths = routerPaths(join(dir, '.router'));
    const result = recordOrchestratorUsage(paths, fixedClock(UNTIL), {
      planId: 'plan-empty',
      sinceIso: '2026-07-24T15:00:00.000Z',
      untilIso: '2026-07-24T15:30:00.000Z',
      transcriptPath: FIXTURE,
      model: 'opus',
    });

    assert.deepEqual(result, { recorded: false, reason: 'no matching main-model turns' });
    assert.equal(existsSync(paths.metrics), false);
    assert.deepEqual(readJsonl<MetricRecord>(paths.metrics), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrator-usage command records JSON output and degrades with exit code zero', () => {
  const dir = tmp();
  try {
    const routerDir = join(dir, '.router');
    const baseArgs = [
      ENTRY,
      'orchestrator-usage',
      '--plan',
      'plan-cli',
      '--since',
      SINCE,
      '--until',
      UNTIL,
      '--transcript',
      FIXTURE,
      '--router-dir',
      routerDir,
    ];
    const output = execFileSync(process.execPath, [...baseArgs, '--json'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), {
      ok: true,
      recorded: true,
      plan: 'plan-cli',
      tokens_input: 77,
      tokens_output: 14,
      cost_usd: deriveCost('opus', 77, 14),
    });

    const degraded = execFileSync(
      process.execPath,
      [
        ENTRY,
        'orchestrator-usage',
        '--plan',
        'plan-empty',
        '--since',
        '2026-07-24T15:00:00.000Z',
        '--transcript',
        FIXTURE,
        '--router-dir',
        routerDir,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.match(
      degraded,
      /orchestrator usage not recorded: no matching main-model turns; usage will show execution side only/,
    );
    assert.equal(readJsonl<MetricRecord>(join(routerDir, 'metrics.jsonl')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
