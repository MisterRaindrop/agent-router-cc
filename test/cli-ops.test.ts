// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { runCli } from '../src/cli/main.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import { resolveCommit } from '../src/io/git.ts';
import * as store from '../src/io/store.ts';
import { hashContract } from '../src/core/contractHash.ts';
import { createTask, currentState, transition } from '../src/app/transition.ts';
import { CapExceededError, startRun } from '../src/app/worker.ts';
import type { MetricRecord } from '../src/domain/types.ts';

const NODE = process.execPath;

// Capture stdout while running a verb in-process (mirrors cli.test.ts).
async function cli(cwd: string, argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    const code = await runCli(argv, cwd);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

function policyText(extra = ''): string {
  return (
    `schema_version: 1\nmax_concurrent_workers: 1\nworker:\n  kind: codex\n  api_key_env: OPENAI_API_KEY\n  stall_minutes: 1\n` +
    `scope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\n` +
    `verification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n` +
    extra
  );
}

function taskYaml(id: string, allowed: string[]): string {
  return (
    `schema_version: 1\nid: ${id}\ntitle: ${id}\nbase_sha: null\nmax_wall_minutes: 1\n` +
    `allowed_globs: ${JSON.stringify(allowed)}\nbuild_ref: build\ntest_ref: test\n`
  );
}

function setup(policyExtra = '') {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.router/policy.yaml', policyText(policyExtra));
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  const base = fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  return { repo, base, paths, deps: { paths, clock: fixedClock('2026-07-09T00:00:00.000Z') } };
}

function validatedQueued(deps: ReturnType<typeof setup>['deps'], repo: string, id: string, allowed: string[]): void {
  const base = resolveCommit(repo, 'HEAD');
  mkdirSync(deps.paths.taskDir(id), { recursive: true });
  const yaml = taskYaml(id, allowed);
  writeFileSync(deps.paths.taskYaml(id), yaml);
  writeFileSync(deps.paths.contractMd(id), '# Contract\nc\n');
  const hash = hashContract(yaml, '# Contract\nc\n');
  createTask(deps, id, id);
  transition(deps, id, 'VALIDATED', { actor: 'v', meta: { base_sha: base, contract_hash: hash } });
  transition(deps, id, 'QUEUED', { actor: 'q' });
}

const metric = (taskId: string, over: Partial<MetricRecord> = {}): MetricRecord => ({
  ts: '2026-07-09T00:00:00.000Z',
  task_id: taskId,
  run_id: 'run-001',
  attempt_number: 1,
  model: 'codex',
  exit_class: 'task_failed',
  verifier_result: 'FAILED',
  first_pass: false,
  tokens_input: 100,
  tokens_output: 50,
  cost_usd: 0.5,
  wall_seconds: 10,
  escalated: false,
  env_error: false,
  ...over,
});

// -- Feature 1: budget / attempt caps ---------------------------------------

test('startRun refuses once max_attempts is reached (deterministic guard)', () => {
  const { repo, deps } = setup('escalation:\n  max_attempts: 1\n');
  try {
    validatedQueued(deps, repo, 't1', ['src/**']);
    store.appendMetric(deps.paths, metric('t1', { exit_class: 'task_failed' })); // 1 counting attempt
    assert.throws(() => startRun(deps, 't1'), CapExceededError);
  } finally {
    fx.cleanup(repo);
  }
});

test('startRun refuses once the cost budget cap is reached', () => {
  const { repo, deps } = setup('budget_caps:\n  max_cost_usd: 1.0\n');
  try {
    validatedQueued(deps, repo, 't1', ['src/**']);
    store.appendMetric(deps.paths, metric('t1', { cost_usd: 1.5 }));
    assert.throws(() => startRun(deps, 't1'), CapExceededError);
  } finally {
    fx.cleanup(repo);
  }
});

test('startRun proceeds when under the caps', () => {
  const { repo, deps, paths } = setup('escalation:\n  max_attempts: 3\n');
  try {
    validatedQueued(deps, repo, 't1', ['src/**']);
    store.appendMetric(deps.paths, metric('t1'));
    const started = startRun(deps, 't1');
    assert.ok(started.runId);
    assert.equal(currentState(paths, 't1')?.state, 'RUNNING');
  } finally {
    fx.cleanup(repo);
  }
});

// -- Feature 3: router gc ----------------------------------------------------

test('gc rotates metrics.jsonl to keep the last N', async () => {
  const { repo, paths } = setup();
  try {
    for (let i = 0; i < 5; i++) store.appendMetric(paths, metric(`t${i}`));
    const r = await cli(repo, ['gc', '--keep-metrics', '2', '--json']);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out);
    assert.equal(out.metrics_dropped, 3);
    assert.equal(out.metrics_kept, 2);
    assert.equal(store.readMetrics(paths).length, 2);
    assert.ok(existsSync(paths.metricsArchive));
    // the archive holds exactly the dropped records
    assert.equal(readFileSync(paths.metricsArchive, 'utf8').trim().split('\n').length, 3);
  } finally {
    fx.cleanup(repo);
  }
});

test('gc --dry-run reports but does not modify metrics', async () => {
  const { repo, paths } = setup();
  try {
    for (let i = 0; i < 5; i++) store.appendMetric(paths, metric(`t${i}`));
    const r = await cli(repo, ['gc', '--keep-metrics', '1', '--dry-run', '--json']);
    assert.equal(JSON.parse(r.out).metrics_dropped, 4);
    assert.equal(store.readMetrics(paths).length, 5); // untouched
    assert.equal(existsSync(paths.metricsArchive), false);
  } finally {
    fx.cleanup(repo);
  }
});

// -- Feature 4: approval gate + glob-derived risk ----------------------------

function drivePassed(deps: ReturnType<typeof setup>['deps'], repo: string, id: string, allowed: string[]): void {
  const base = resolveCommit(repo, 'HEAD');
  mkdirSync(deps.paths.taskDir(id), { recursive: true });
  writeFileSync(deps.paths.taskYaml(id), taskYaml(id, allowed));
  writeFileSync(deps.paths.contractMd(id), '# Contract\nc\n');
  createTask(deps, id, id);
  transition(deps, id, 'VALIDATED', { actor: 'v', meta: { base_sha: base, contract_hash: 'h' } });
  transition(deps, id, 'QUEUED', { actor: 'q' });
  transition(deps, id, 'RUNNING', { actor: 'r', runId: 'run-001', meta: { attempt_number: 1 } });
  transition(deps, id, 'VERIFYING', { actor: 'w', runId: 'run-001' });
  transition(deps, id, 'PASSED', { actor: 'w', runId: 'run-001' });
}

test('merge refuses a high-risk task without approval', async () => {
  const { repo, deps, paths } = setup();
  try {
    drivePassed(deps, repo, 'hi', ['src/**', 'package.json']);
    const r = await cli(repo, ['merge', 'hi', '--json']);
    assert.equal(r.code, 1);
    assert.match(JSON.parse(r.out).error, /high-risk/);
    assert.equal((currentState(paths, 'hi'))?.state, 'PASSED'); // not merged
  } finally {
    fx.cleanup(repo);
  }
});

test('router approve records approval; then merge passes the risk gate', async () => {
  const { repo, deps, paths } = setup();
  try {
    drivePassed(deps, repo, 'hi', ['src/**', 'package.json']);
    const a = await cli(repo, ['approve', 'hi', '--json']);
    assert.equal(a.code, 0);
    assert.equal(JSON.parse(a.out).risk, 'high');
    assert.ok(store.readApproval(paths, 'hi') !== null);
    // the risk gate is now satisfied; merge fails LATER (no real run branch),
    // proving the refusal was on the merge mechanics, not the approval gate.
    const r = await cli(repo, ['merge', 'hi', '--json']);
    assert.equal(r.code, 1);
    assert.doesNotMatch(JSON.parse(r.out).error, /high-risk/);
  } finally {
    fx.cleanup(repo);
  }
});

test('a low-risk task is not blocked by the approval gate', async () => {
  const { repo, deps } = setup();
  try {
    drivePassed(deps, repo, 'lo', ['src/**']);
    const r = await cli(repo, ['merge', 'lo', '--json']);
    assert.equal(r.code, 1); // still fails (no branch) but NOT for risk
    assert.doesNotMatch(JSON.parse(r.out).error, /high-risk/);
  } finally {
    fx.cleanup(repo);
  }
});
