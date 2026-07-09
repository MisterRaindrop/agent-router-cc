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
  runWorkerBody,
  startRun,
  updateLease,
  type WorkerLauncher,
} from '../src/app/worker.ts';

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
      launcher('require("fs").writeFileSync("src/a.ts","export const x = 2;\\n")'),
    );
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(currentState(paths, 't1')?.state, 'PASSED');
    assert.ok(existsSync(paths.diffPatch('t1', runId)));
    const metrics = store.readMetrics(paths);
    assert.equal(metrics.at(-1)?.verifier_result, 'PASSED');
    assert.equal(metrics.at(-1)?.first_pass, true);
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
