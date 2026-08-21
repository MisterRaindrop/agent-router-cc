// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import type { MetricRecord } from '../src/domain/types.ts';
import { readJsonl } from '../src/io/jsonl.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import { CheckoutBusyError, dispatchTask, dispatchTasks, orderByQuota, prepareRun, runPrepared } from '../src/app/dispatch.ts';
import { acquireLock } from '../src/io/lock.ts';
import { currentBranch, uncommittedSourceFiles } from '../src/io/git.ts';

const NODE = process.execPath;
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../testkit/fakeClaude.mjs', import.meta.url));
const FAKE_ENV = fileURLToPath(new URL('../testkit/fakeExecutorEnv.mjs', import.meta.url));

const POLICY = `schema_version: 1
worker:
  kind: codex
scope:
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
verify: []
`;
const CONTRACT = '# Contract\nEdit src.\n';

function setup(policy = POLICY): { repo: string; paths: ReturnType<typeof routerPaths>; deps: { paths: ReturnType<typeof routerPaths>; clock: ReturnType<typeof fixedClock> } } {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.router/policy.yaml', policy);
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  return { repo, paths, deps: { paths, clock: fixedClock('2026-07-15T00:00:00.000Z') } };
}

function stageTask(paths: ReturnType<typeof routerPaths>, taskYaml = TASK_YAML): void {
  mkdirSync(paths.taskDir('t1'), { recursive: true });
  writeFileSync(paths.taskYaml('t1'), taskYaml);
  writeFileSync(paths.contractMd('t1'), CONTRACT);
}

function stageContext(
  paths: ReturnType<typeof routerPaths>,
  baseSha: string,
  markdown = '# Navigation\nRead src/a.ts.\n',
  planRevision?: string,
): string {
  const text =
    `---\ntask_id: t1\nbase_sha: ${baseSha}\n` +
    (planRevision === undefined ? '' : `plan_revision: ${planRevision}\n`) +
    `---\n${markdown}`;
  writeFileSync(paths.taskContext('t1'), text);
  return text;
}

function stageScopedTask(paths: ReturnType<typeof routerPaths>, id: string): void {
  mkdirSync(paths.taskDir(id), { recursive: true });
  writeFileSync(
    paths.taskYaml(id),
    `schema_version: 1
id: ${id}
title: ${id}
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/${id}.ts"]
worker: {kind: codex}
verify: []
`,
  );
  writeFileSync(paths.contractMd(id), CONTRACT);
}

test('dispatchTask runs the executor synchronously to a PASSED verifier result', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions'); // force fallback (no quota data)
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(result.worker.kind, 'codex');
    // The verified commits are on the task branch in the user's own checkout -- and the run
    // leaves us standing on it, which no worktree run ever did.
    assert.equal(result.branch, 'router/t1');
    assert.equal(currentBranch(paths.repoRoot), 'router/t1');
    assert.match(readFileSync(join(paths.repoRoot, 'src', 'a.ts'), 'utf8'), /fake codex/);
    // The executor committed it; there is no catch-all commit behind it any more.
    assert.deepEqual(result.closeout, { ok: true });
    assert.deepEqual(uncommittedSourceFiles(paths.repoRoot, ['.router']), []);
    assert.match(fx.git(repo, ['log', '-1', '--pretty=%s']).trim(), /^fake: unit a$/);
    const metrics = readJsonl<MetricRecord>(paths.metrics);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.role, 'executor');
    assert.equal('plan_id' in metrics[0]!, false);
    assert.equal(metrics[0]!.risk, 'normal');
    assert.equal(metrics[0]!.conflict, false);
    assert.equal(metrics[0]!.commands_run, 0);
    assert.equal(metrics[0]!.effort, 'medium');
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(repo);
  }
});

test('dispatchTask records the task plan ID on its executor metric', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths, TASK_YAML.replace('id: t1\n', 'id: t1\nplan_id: plan-test-001\n'));
    await dispatchTask(deps, 't1');
    const metrics = readJsonl<MetricRecord>(paths.metrics);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.plan_id, 'plan-test-001');
    assert.equal(metrics[0]!.role, 'executor');
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(repo);
  }
});

test('dispatch records bound task-context metrics and keeps context out of the worktree diff', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const withContext = setup();
  const withoutContext = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  try {
    const task = TASK_YAML.replace('id: t1\n', 'id: t1\nplan_revision: rev-1\n');
    stageTask(withContext.paths, task);
    stageTask(withoutContext.paths, task);
    const baseSha = fx.git(withContext.repo, ['rev-parse', 'HEAD']).trim();
    const contextText = stageContext(withContext.paths, baseSha, '# Navigation\nRead src/a.ts.\n', 'rev-1');

    process.env.ROUTER_CODEX_SESSIONS_DIR = join(withContext.repo, 'no-sessions');
    await dispatchTask(withContext.deps, 't1');
    process.env.ROUTER_CODEX_SESSIONS_DIR = join(withoutContext.repo, 'no-sessions');
    await dispatchTask(withoutContext.deps, 't1');

    const metrics = readJsonl<MetricRecord>(withContext.paths.metrics);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.task_context_present, true);
    assert.equal(metrics[0]!.task_context_chars, contextText.length);
    assert.equal(metrics[0]!.task_context_sha256, createHash('sha256').update(contextText).digest('hex'));
    assert.equal(metrics[0]!.context_base_sha, baseSha);
    assert.equal(metrics[0]!.plan_revision, 'rev-1');

    assert.equal(
      readFileSync(withContext.paths.diffPatch('t1', 'run-001'), 'utf8'),
      readFileSync(withoutContext.paths.diffPatch('t1', 'run-001'), 'utf8'),
    );
    assert.equal(existsSync(join(withContext.paths.worktree('t1', 'run-001'), 'TASK_CONTEXT.md')), false);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(withContext.repo);
    fx.cleanup(withoutContext.repo);
  }
});

test('a stale task context fails before a worktree or executor is started', async () => {
  const { repo, paths, deps } = setup();
  try {
    stageTask(paths);
    stageContext(paths, 'stale-base-sha');
    await assert.rejects(
      dispatchTask(deps, 't1'),
      /base_sha mismatch.*context describes "stale-base-sha".*dispatch base is "[0-9a-f]{40}".*regenerate/s,
    );
    assert.equal(existsSync(paths.worktree('t1', 'run-001')), false);
    assert.equal(existsSync(paths.workerLog('t1', 'run-001')), false);
  } finally {
    fx.cleanup(repo);
  }
});

test('an oversize task context is flagged on the result and not truncated in preparation', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const baseSha = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    const tail = 'END-OF-CONTEXT';
    const contextText = stageContext(paths, baseSha, `${'x'.repeat(8_100)}${tail}`);
    const prepared = prepareRun(deps, 't1');
    assert.equal(prepared.context?.text, contextText);
    assert.ok(prepared.context?.text.endsWith(tail));
    const result = await runPrepared(deps, prepared);
    assert.equal(result.context_oversize, true);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(repo);
  }
});

test('prepareRun and runPrepared compose to the same dispatch result', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const directSetup = setup();
  const composedSetup = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(directSetup.repo, 'no-sessions');
  try {
    stageTask(directSetup.paths);
    stageTask(composedSetup.paths);
    const direct = await dispatchTask(directSetup.deps, 't1');
    process.env.ROUTER_CODEX_SESSIONS_DIR = join(composedSetup.repo, 'no-sessions');
    const composed = await runPrepared(composedSetup.deps, prepareRun(composedSetup.deps, 't1'));
    assert.deepEqual(
      {
        task_id: composed.task_id,
        exit_class: composed.exit_class,
        verifier: composed.verifier?.result,
        worker: composed.worker,
        tokens: composed.tokens,
      },
      {
        task_id: direct.task_id,
        exit_class: direct.exit_class,
        verifier: direct.verifier?.result,
        worker: direct.worker,
        tokens: direct.tokens,
      },
    );
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(directSetup.repo);
    fx.cleanup(composedSetup.repo);
  }
});

test('dispatchTasks rejects duplicate ids before touching the checkout', async () => {
  const { repo, paths, deps } = setup();
  try {
    stageTask(paths);
    await assert.rejects(dispatchTasks(deps, ['t1', 't1']), /duplicate task id: t1/);
  } finally {
    fx.cleanup(repo);
  }
});

test('dispatchTasks completes every task in input order, one at a time', async () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_SCOPED;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageScopedTask(paths, 'p1');
    stageScopedTask(paths, 'p2');
    const results = await dispatchTasks(deps, ['p2', 'p1']);
    assert.deepEqual(results.map((result) => result.task_id), ['p2', 'p1']);
    assert.deepEqual(results.map((result) => result.verifier?.result), ['PASSED', 'PASSED']);
    // Serial, not merely ordered: the second executor must not start before the first ended.
    assert.ok(
      Date.parse(results[1]!.started_at) >= Date.parse(results[0]!.ended_at),
      `runs overlapped: ${results[0]!.started_at}..${results[0]!.ended_at} vs ${results[1]!.started_at}`,
    );
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

test('dispatch falls back when the first executor has an environment error', async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  const { repo, paths, deps } = setup();
  const prevCodex = process.env.ROUTER_CODEX_BIN;
  const prevClaude = process.env.ROUTER_CLAUDE_BIN;
  process.env.ROUTER_CODEX_BIN = 'router-no-such-codex-binary';
  process.env.ROUTER_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(result.worker.kind, 'claude');
    assert.equal(result.executor_switches, 1);
  } finally {
    if (prevCodex === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prevCodex;
    if (prevClaude === undefined) delete process.env.ROUTER_CLAUDE_BIN;
    else process.env.ROUTER_CLAUDE_BIN = prevClaude;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

test('explicit executor key is not exposed to repository verification commands', async () => {
  chmodSync(FAKE_ENV, 0o755);
  const { repo, paths, deps } = setup();
  const prevBin = process.env.ROUTER_CODEX_BIN;
  const prevKey = process.env.ROUTER_TEST_API_KEY;
  process.env.ROUTER_CODEX_BIN = FAKE_ENV;
  process.env.ROUTER_TEST_API_KEY = 'executor-secret';
  const task = `schema_version: 1
id: t1
title: demo
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
worker: {kind: codex, api_key_env: ROUTER_TEST_API_KEY}
verify:
  - [${JSON.stringify(NODE)}, "-e", "process.exit(process.env.ROUTER_TEST_API_KEY ? 9 : 0)"]
`;
  try {
    stageTask(paths, task);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
  } finally {
    if (prevBin === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prevBin;
    if (prevKey === undefined) delete process.env.ROUTER_TEST_API_KEY;
    else process.env.ROUTER_TEST_API_KEY = prevKey;
    fx.cleanup(repo);
  }
});

test('orderByQuota puts the executor with the most real headroom first', () => {
  const twoWorkers = POLICY.replace('worker:\n  kind: codex', 'workers:\n  - kind: codex\n  - kind: claude');
  const { repo, paths } = setup(twoWorkers);
  const sessions = join(repo, 'codex-sessions', '2026', '07', '15');
  mkdirSync(sessions, { recursive: true });
  // codex 90% used; claude 10% used -> claude should lead.
  writeFileSync(
    join(sessions, 'rollout-x.jsonl'),
    JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 90, window_minutes: 300, resets_at: 1 }, rate_limit_reached_type: null } } }) + '\n',
  );
  writeFileSync(join(paths.root, 'usage.json'), JSON.stringify({ used_percent: 10, resets_at: 2, reached: false }));
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'codex-sessions');
  try {
    const workers = [{ kind: 'codex' as const }, { kind: 'claude' as const }];
    const { order } = orderByQuota(paths, workers);
    assert.equal(order[0]!.kind, 'claude');
    assert.equal(order[1]!.kind, 'codex');
  } finally {
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

// Fault-injection case 8a. The lock has to be taken before the FIRST write, not at dispatch
// time: under the branch model the resource being protected is the user's own checkout, and it
// starts changing at the rescue commit. A second run must therefore be turned away with the
// checkout untouched -- no rescue commit, no branch, no branch switch.
test('a second dispatch is refused before it writes anything (8a)', async () => {
  const { repo, paths, deps } = setup();
  try {
    stageTask(paths);
    // Someone else's uncommitted work, sitting in the tree. If the refusal came too late, this
    // is what would already have been swept into a commit by the time we bailed.
    fx.write(repo, 'src/user-was-editing.ts', 'export const wip = true;\n');
    const branchesBefore = fx.git(repo, ['branch', '--format=%(refname:short)']);
    const headBefore = fx.git(repo, ['rev-parse', 'HEAD']).trim();

    const held = acquireLock(paths.gateLock(), { waitMs: 0 });
    assert.ok(!('blocked' in held));
    try {
      await assert.rejects(dispatchTask(deps, 't1'), (err: unknown) => {
        assert.ok(err instanceof CheckoutBusyError, `expected CheckoutBusyError, got ${String(err)}`);
        assert.equal(err.holderPid, process.pid);
        assert.match(err.message, /router runs one task at a time/);
        return true;
      });
    } finally {
      held.release();
    }

    assert.equal(fx.git(repo, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.equal(fx.git(repo, ['branch', '--format=%(refname:short)']), branchesBefore);
    assert.deepEqual(uncommittedSourceFiles(paths.repoRoot, ['.router']), ['?? src/user-was-editing.ts']);
  } finally {
    fx.cleanup(repo);
  }
});

// Fault-injection case 8f, and the reason the catch-all `commitAll` could not simply be deleted.
// A file the executor forgets never enters base_sha..HEAD, so every gate passes without ever
// seeing it: the run would report success while unreviewed code sat in the user's checkout.
test('an executor that forgets a file fails the run instead of passing the gate (8f)', async () => {
  const { repo, paths, deps } = setup();
  const forgetful = join(repo, 'fake-forgetful.mjs');
  writeFileSync(
    forgetful,
    '#!/usr/bin/env node\n' +
      'import {writeFileSync} from "node:fs";import {execFileSync} from "node:child_process";\n' +
      // One unit committed properly...
      'writeFileSync("src/a.ts","export const x = 2;\\n");\n' +
      'execFileSync("git",["add","--","src/a.ts"]);\n' +
      'execFileSync("git",["-c","user.name=f","-c","user.email=f@l","commit","-q","-m","fake: unit a"]);\n' +
      // ...and a second file left behind.
      'writeFileSync("src/forgotten.ts","export const oops = true;\\n");\n' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(forgetful, 0o755);
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = forgetful;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');

    assert.equal(result.exit_class, 'task_failed');
    assert.equal(result.closeout?.ok, false);
    assert.ok(result.closeout !== undefined && !result.closeout.ok);
    assert.match(result.closeout.reason, /did not commit its last unit/);
    assert.deepEqual(result.closeout.files, ['?? src/forgotten.ts']);
    // Never verified -- not verified-and-failed. Running the gate on a diff that is missing a
    // file would produce a pass that means nothing.
    assert.equal(result.verifier, undefined);
    // And the work is still there to be finished.
    assert.match(readFileSync(join(paths.repoRoot, 'src', 'forgotten.ts'), 'utf8'), /oops/);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});
