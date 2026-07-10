// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { resolveCommit } from '../src/io/git.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import * as store from '../src/io/store.ts';
import { hashContract } from '../src/core/contractHash.ts';
import { createTask, currentState, transition } from '../src/app/transition.ts';
import { hostname } from 'node:os';
import {
  ConcurrencyLimitError,
  RunStateError,
  runWorkerBody,
  startRun,
  updateLease,
  type WorkerLauncher,
} from '../src/app/worker.ts';
import type { Policy } from '../src/domain/types.ts';

const NODE = process.execPath;

const POLICY = `schema_version: 1
max_concurrent_workers: 1
worker:
  kind: codex
  api_key_env: OPENAI_API_KEY
  stall_minutes: 1
scope:
  forbidden_globs: []
  test_globs: ["tests/**"]
  max_changed_lines: 400
verification:
  build:
    - ["${NODE}", "-e", "process.exit(0)"]
  test:
    - ["${NODE}", "-e", "process.exit(0)"]
`;

const TASK_YAML = `schema_version: 1
id: t1
title: demo
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
build_ref: build
test_ref: test
`;
const CONTRACT = '# Contract\nEdit src.\n';

function setup() {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.router/policy.yaml', POLICY);
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  const base = fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  const deps = { paths, clock: fixedClock('2026-07-09T00:00:00.000Z') };
  return { repo, base, paths, deps };
}

function validatedQueued(
  deps: ReturnType<typeof setup>['deps'],
  repo: string,
  id: string,
  taskYaml = TASK_YAML,
): void {
  const base = resolveCommit(repo, 'HEAD');
  mkdirSync(deps.paths.taskDir(id), { recursive: true });
  writeFileSync(deps.paths.taskYaml(id), taskYaml);
  writeFileSync(deps.paths.contractMd(id), CONTRACT);
  const hash = hashContract(taskYaml, CONTRACT);
  createTask(deps, id, 'demo');
  transition(deps, id, 'VALIDATED', { actor: 'v', meta: { base_sha: base, contract_hash: hash } });
  transition(deps, id, 'QUEUED', { actor: 'q' });
}

const launcher = (script: string, argv?: string[]): WorkerLauncher => ({
  kind: 'codex',
  model: 'fake',
  buildArgv: () => argv ?? [NODE, '-e', script],
});

test('happy path: worker edits in-scope, verifier passes, task PASSED', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    assert.equal(currentState(paths, 't1')?.state, 'RUNNING');
    const result = await runWorkerBody(
      deps,
      't1',
      runId,
      launcher(
        'require("fs").writeFileSync("src/a.ts","export const x = 2;\\n");' +
          'console.log(JSON.stringify({type:"thread.started",model:"stream-model"}));' +
          'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1200,output_tokens:70}}))',
      ),
    );
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    // model came from the --json stream (overrides the launcher's pinned model)
    assert.equal(result.worker.model, 'stream-model');
    assert.equal(currentState(paths, 't1')?.state, 'PASSED');
    assert.ok(existsSync(paths.diffPatch('t1', runId)));
    const metrics = store.readMetrics(paths);
    assert.equal(metrics.at(-1)?.verifier_result, 'PASSED');
    assert.equal(metrics.at(-1)?.first_pass, true);
    // token usage parsed from the (fake) codex --json stream flows into metrics
    assert.equal(result.tokens?.input, 1200);
    assert.equal(metrics.at(-1)?.tokens_output, 70);
    assert.equal(metrics.at(-1)?.model, 'stream-model');
  } finally {
    fx.cleanup(repo);
  }
});

test('scope trap (no codex): worker writes out-of-scope file => verifier FAILS, task FAILED', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    const result = await runWorkerBody(
      deps,
      't1',
      runId,
      launcher('require("fs").mkdirSync("docs",{recursive:true});require("fs").writeFileSync("docs/x.md","oops\\n")'),
    );
    assert.equal(result.exit_class, 'ok'); // worker "succeeded"...
    assert.equal(result.verifier?.result, 'FAILED'); // ...but the gate caught it
    assert.ok(result.verifier?.checks.some((c) => c.id === 'scope' && !c.ok));
    assert.equal(currentState(paths, 't1')?.state, 'FAILED');
  } finally {
    fx.cleanup(repo);
  }
});

test('worker exits nonzero => task_failed, no verification', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    const result = await runWorkerBody(deps, 't1', runId, launcher('process.exit(1)'));
    assert.equal(result.exit_class, 'task_failed');
    assert.equal(result.verifier, undefined);
    assert.equal(currentState(paths, 't1')?.state, 'FAILED');
  } finally {
    fx.cleanup(repo);
  }
});

test('unlaunchable worker => env_error, marked not-counting-as-attempt', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    const result = await runWorkerBody(deps, 't1', runId, launcher('', ['router-no-such-bin-xyz']));
    assert.equal(result.exit_class, 'env_error');
    assert.equal(result.env_error, true);
    assert.equal(currentState(paths, 't1')?.state, 'FAILED');
    const events = store.readEvents(paths, 't1');
    assert.equal(events.at(-1)?.meta?.counts_as_attempt, false);
  } finally {
    fx.cleanup(repo);
  }
});

test('startRun writes lease.host as os.hostname() (regression #1)', () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    assert.equal(store.readLease(paths, 't1', runId)?.host, hostname());
  } finally {
    fx.cleanup(repo);
  }
});

test('updateLease merges fields without clobbering (regression #3)', () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    updateLease(deps, 't1', runId, { supervisor_pid: 111 });
    updateLease(deps, 't1', runId, { worker_pgid: 222 });
    const lease = store.readLease(paths, 't1', runId);
    assert.equal(lease?.supervisor_pid, 111); // not clobbered by the second write
    assert.equal(lease?.worker_pgid, 222);
  } finally {
    fx.cleanup(repo);
  }
});

test('quota fallback: primary hits quota -> switch to fallback -> PASSED (no attempt consumed)', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    // primary prints a quota signature and fails; must be reclassified quota_exhausted
    const primary = launcher('console.log("Error: 429 rate limit exceeded"); process.exit(1)');
    const fallback = launcher('require("fs").writeFileSync("src/a.ts","export const x = 2;\\n")');
    const result = await runWorkerBody(deps, 't1', runId, primary, undefined, [fallback]);
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.executor_switches, 1);
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(currentState(paths, 't1')?.state, 'PASSED');
  } finally {
    fx.cleanup(repo);
  }
});

test('quota fallback: all executors exhausted -> quota_exhausted, FAILED, not an attempt', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    const q = () => launcher('console.log("rate_limited"); process.exit(1)');
    const result = await runWorkerBody(deps, 't1', runId, q(), undefined, [q()]);
    assert.equal(result.exit_class, 'quota_exhausted');
    assert.equal(result.executor_switches, 1);
    assert.equal(result.verifier, undefined);
    assert.equal(currentState(paths, 't1')?.state, 'FAILED');
    assert.equal(store.readEvents(paths, 't1').at(-1)?.meta?.counts_as_attempt, false);
  } finally {
    fx.cleanup(repo);
  }
});

// -- escalation ladder ------------------------------------------------------

const ESC_POLICY: Policy = {
  schema_version: 1,
  scope: { forbidden_globs: [], test_globs: ['tests/**'], max_changed_lines: 400 },
  verification: {
    build: [[NODE, '-e', 'process.exit(0)']],
    test: [[NODE, '-e', 'process.exit(0)']],
  },
  worker: { kind: 'codex', api_key_env: 'OPENAI_API_KEY', stall_minutes: 1 },
  escalation: { max_attempts: 3 },
};

/** Start a run and run a failing worker; returns the resulting state + runId. */
async function failOnce(
  deps: ReturnType<typeof setup>['deps'],
  paths: ReturnType<typeof setup>['paths'],
): Promise<{ state: string; runId: string }> {
  const { runId } = startRun(deps, 't1');
  const result = await runWorkerBody(deps, 't1', runId, launcher('process.exit(1)'), ESC_POLICY);
  assert.equal(result.exit_class, 'task_failed');
  return { state: currentState(paths, 't1')!.state, runId };
}

test('escalation ladder: FAILED -> ESCALATED_1 -> ESCALATED_2 -> NEEDS_REPLAN', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');

    // attempt 1 fails -> retry rung
    const r1 = await failOnce(deps, paths);
    assert.equal(r1.state, 'ESCALATED_1');

    // attempt 2 fails -> rescue rung
    const r2 = await failOnce(deps, paths);
    assert.equal(r2.state, 'ESCALATED_2');

    // attempt 3 starts from ESCALATED_2: the RUNNING event marks it a rescue attempt
    const { runId: run3 } = startRun(deps, 't1');
    const running3 = store.readEvents(paths, 't1').find((e) => e.to === 'RUNNING' && e.run_id === run3);
    assert.equal(running3?.from, 'ESCALATED_2'); // isRescueAttempt() would pick the rescue worker
    const res3 = await runWorkerBody(deps, 't1', run3, launcher('process.exit(1)'), ESC_POLICY);
    assert.equal(res3.exit_class, 'task_failed');
    assert.equal(currentState(paths, 't1')!.state, 'NEEDS_REPLAN');

    // NEEDS_REPLAN is a dead end: no auto-retry from here.
    assert.throws(() => startRun(deps, 't1'), RunStateError);

    // every failed run that advanced the ladder is flagged escalated in metrics.
    const metrics = store.readMetrics(paths).filter((m) => m.task_id === 't1');
    assert.equal(metrics.length, 3);
    assert.deepEqual(metrics.map((m) => m.attempt_number), [1, 2, 3]);
    assert.deepEqual(metrics.map((m) => m.escalated), [true, true, true]);
  } finally {
    fx.cleanup(repo);
  }
});

test('escalation is opt-in: without escalation policy a FAILED run stays FAILED', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    // setup()'s on-disk POLICY has no escalation block -> no ladder advance.
    const result = await runWorkerBody(deps, 't1', runId, launcher('process.exit(1)'));
    assert.equal(result.exit_class, 'task_failed');
    assert.equal(currentState(paths, 't1')!.state, 'FAILED');
    assert.equal(store.readMetrics(paths).at(-1)?.escalated, false);
  } finally {
    fx.cleanup(repo);
  }
});

test('non-counting failure (env_error) does NOT advance the ladder', async () => {
  const { repo, deps, paths } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    const { runId } = startRun(deps, 't1');
    // Unlaunchable binary => env_error; even with escalation enabled the ladder
    // must NOT advance (attempt did not really happen).
    const result = await runWorkerBody(deps, 't1', runId, launcher('', ['router-no-such-bin-xyz']), ESC_POLICY);
    assert.equal(result.exit_class, 'env_error');
    assert.equal(currentState(paths, 't1')!.state, 'FAILED');
    assert.equal(store.readMetrics(paths).at(-1)?.escalated, false);
  } finally {
    fx.cleanup(repo);
  }
});

test('max_concurrent_workers=1 rejects a second concurrent run', () => {
  const { repo, deps } = setup();
  try {
    validatedQueued(deps, repo, 't1');
    validatedQueued(deps, repo, 't2');
    startRun(deps, 't1'); // t1 now RUNNING
    assert.throws(() => startRun(deps, 't2'), ConcurrencyLimitError);
  } finally {
    fx.cleanup(repo);
  }
});

test('dependency gate: startRun refuses until depends_on tasks are MERGED', () => {
  const { repo, deps, paths } = setup();
  try {
    const parentYaml = TASK_YAML.replace('id: t1', 'id: dep-parent');
    const childYaml = TASK_YAML.replace('id: t1', 'id: dep-child') + 'depends_on: ["dep-parent"]\n';
    validatedQueued(deps, repo, 'dep-parent', parentYaml);
    validatedQueued(deps, repo, 'dep-child', childYaml);

    assert.throws(
      () => startRun(deps, 'dep-child'),
      (e: Error) => e.name === 'DependencyError' && /dep-parent/.test(e.message),
    );

    // Walk dep-parent to MERGED; the gate then opens.
    transition(deps, 'dep-parent', 'RUNNING', { actor: 't' });
    transition(deps, 'dep-parent', 'VERIFYING', { actor: 't' });
    transition(deps, 'dep-parent', 'PASSED', { actor: 't' });
    transition(deps, 'dep-parent', 'MERGED', { actor: 't' });
    const started = startRun(deps, 'dep-child');
    assert.ok(started.runId);
    assert.equal(currentState(paths, 'dep-child')!.state, 'RUNNING');
  } finally {
    fx.cleanup(repo);
  }
});
