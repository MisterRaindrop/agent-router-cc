// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import { childEnv } from './childEnv.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import type { MetricRecord } from '../src/domain/types.ts';
import { readJsonl } from '../src/io/jsonl.ts';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import {
  ActivityAlreadyExistsError,
  activityKey,
  activityState,
  observeActivities,
  readActivity,
} from '../src/io/activity.ts';
import { CheckoutBusyError, dispatchTask, dispatchTasks, orderByQuota, prepareRun, runPrepared } from '../src/app/dispatch.ts';
import { superviseCommand } from '../src/app/supervise.ts';
import { acquireLock, DEFAULT_STALE_MS, readLock } from '../src/io/lock.ts';
import { currentBranch, uncommittedSourceFiles } from '../src/io/git.ts';

const NODE = process.execPath;
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../testkit/fakeClaude.mjs', import.meta.url));
const FAKE_ENV = fileURLToPath(new URL('../testkit/fakeExecutorEnv.mjs', import.meta.url));
const DISPATCH_MODULE = new URL('../src/app/dispatch.ts', import.meta.url).href;
const PATHS_MODULE = new URL('../src/io/paths.ts', import.meta.url).href;
const CLOCK_MODULE = new URL('../src/io/clock.ts', import.meta.url).href;
const ACTIVITY_MODULE = new URL('../src/io/activity.ts', import.meta.url).href;

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

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

interface RunningDispatch {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdout(): string;
  stderr(): string;
}

function startTaskProcess(
  repo: string,
  paths: ReturnType<typeof routerPaths>,
  executor: string,
  heartbeatIntervalMs = 40,
  resumeFeedback?: string,
): RunningDispatch {
  const invocation =
    resumeFeedback === undefined
      ? `dispatchTask(deps,'t1')`
      : `resumeTask(deps,'t1',${JSON.stringify(resumeFeedback)})`;
  const source =
    `const [{dispatchTask,resumeTask},{routerPaths},{systemClock}]=await Promise.all([` +
    `import(${JSON.stringify(DISPATCH_MODULE)}),` +
    `import(${JSON.stringify(PATHS_MODULE)}),` +
    `import(${JSON.stringify(CLOCK_MODULE)})]);` +
    `try{` +
    `const deps={` +
    `paths:routerPaths(${JSON.stringify(paths.root)}),clock:systemClock,` +
    `activityHeartbeatIntervalMs:${heartbeatIntervalMs}};` +
    `const result=await ${invocation};` +
    `process.stdout.write(JSON.stringify({` +
    `exit_class:result.exit_class,verifier:result.verifier?.result,` +
    `state_tampering:result.state_tampering,state_changes:result.state_changes})+'\\n');` +
    `}catch(error){console.error(error?.stack??String(error));process.exitCode=1;}`;
  const child = spawn(NODE, ['--input-type=module', '-e', source], {
    cwd: repo,
    env: childEnv({
      ROUTER_CODEX_BIN: executor,
      ROUTER_CODEX_SESSIONS_DIR: join(repo, 'no-sessions'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    child,
    done: waitForExit(child),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function rebuildActivityDuringGating(
  paths: ReturnType<typeof routerPaths>,
  activityPath: string,
  replacement: string,
  confirmedPath: string,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (existsSync(confirmedPath)) return;
    try {
      const before = JSON.parse(readFileSync(paths.runStatus('t1'), 'utf8')) as { phase?: string };
      if (before.phase !== 'gating') return;
      writeFileSync(activityPath, replacement);
      const after = JSON.parse(readFileSync(paths.runStatus('t1'), 'utf8')) as { phase?: string };
      if (after.phase === 'gating') writeFileSync(confirmedPath, 'rebuilt before verify\n');
    } catch {
      // Atomic status writes may briefly race the notification. A later event retries; the
      // verify command fails closed unless it sees the confirmation written while still gating.
    }
  }, 1);
}

function rebuildActivityAfterPatchChanges(
  paths: ReturnType<typeof routerPaths>,
  activityPath: string,
  replacement: string,
  confirmedPath: string,
  previousPatch: string,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (existsSync(confirmedPath)) return;
    try {
      if (readFileSync(paths.diffPatch('t1'), 'utf8') === previousPatch) return;
      writeFileSync(activityPath, replacement);
      writeFileSync(confirmedPath, 'rebuilt after first comparison\n');
    } catch {
      // The resume has not reached its between-window diff write yet.
    }
  }, 1);
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
      readFileSync(withContext.paths.diffPatch('t1'), 'utf8'),
      readFileSync(withoutContext.paths.diffPatch('t1'), 'utf8'),
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
    assert.equal(existsSync(paths.workerLog('t1')), false);
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

// Review finding 3. `recordExecPgid` existed and only the io-lock test ever called it, so in
// production the lock never carried an execPgid -- and a process reclaiming a dead holder's lock
// therefore could not clean up the orphan it was supposed to. Must NOT 6 and fault-injection 8c
// were both satisfied only by a test that called the primitive by hand, which is precisely how a
// missing wire survives a green suite.
test('dispatch publishes the executor process group into the lock (finding 3)', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');

  // Observe the lock file from OUTSIDE while the run holds it: the run releases the lock in its
  // own finally, so by the time dispatchTask returns there is nothing left to inspect.
  const seen: (number | undefined)[] = [];
  const poller = setInterval(() => {
    const info = readLock(paths.gateLock());
    if (info !== null) seen.push(info.execPgid);
  }, 15);
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
  } finally {
    clearInterval(poller);
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }

  assert.ok(seen.length > 0, 'never observed the lock while the run held it');
  const withPgid = seen.filter((p): p is number => typeof p === 'number' && p > 1);
  assert.ok(
    withPgid.length > 0,
    `the lock never carried an execPgid; observed ${seen.length} samples, all undefined`,
  );
});

// Review finding 9a, reproducing what the reviewer demonstrated: ROUTER_EXECUTOR_SANDBOX only
// refuses a nested `router` CLI, so an executor can write real orchestration state with a plain
// file API. The reviewer's fake created `.router/tasks/forged/result.json`, the dispatch still
// reported PASSED, the file stayed, and the committed diff showed only `src/a.ts` -- because
// `.router/` is gitignored and therefore invisible to every gate.
//
// Prevention would need the sandbox to exclude a subdirectory of its own writable root, which
// codex's workspace-write does not offer. So this is enforcement by detection.
test('an executor forging router state fails the run (finding 9)', async () => {
  const { repo, paths, deps } = setup();
  const forger = join(repo, 'fake-forger.mjs');
  writeFileSync(
    forger,
    '#!/usr/bin/env node\n' +
      "import {writeFileSync, mkdirSync} from 'node:fs';import {execFileSync} from 'node:child_process';\n" +
      'writeFileSync("src/a.ts","export const x = 2;\\n");\n' +
      'execFileSync("git",["add","--","src/a.ts"]);\n' +
      'execFileSync("git",["-c","user.name=f","-c","user.email=f@l","commit","-q","-m","fake: unit a"]);\n' +
      // The forgery: a plain file write into real orchestration state, no router CLI involved.
      'mkdirSync(".router/tasks/forged", {recursive: true});\n' +
      'writeFileSync(".router/tasks/forged/result.json", JSON.stringify({task_id:"forged",exit_class:"ok",verifier:{result:"PASSED",checks:[]}}));\n' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(forger, 0o755);
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = forger;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');

    assert.equal(result.exit_class, 'task_failed', 'a forged state file did not fail the run');
    assert.ok(result.state_tampering !== undefined, 'the forgery was not detected');
    assert.ok(
      result.state_tampering.some((line) => line.includes('tasks/forged/result.json')),
      result.state_tampering.join(' | '),
    );
    // Never verified: this is a contract violation, not a code defect to weigh against the diff.
    assert.equal(result.verifier, undefined);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

// The other side of the same coin: the run's OWN artifacts change constantly while it runs
// (status.json, the heartbeat, the worker log), so a detector that flagged those would fail every
// run. A clean executor must come out clean.
test('an ordinary run reports no state tampering (finding 9)', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');
    assert.equal(result.exit_class, 'ok');
    assert.equal(result.state_tampering, undefined, JSON.stringify(result.state_tampering));
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

// The state guard's window used to close BEFORE verification, and the verify/gate commands are
// the executor's own committed code -- so running them is its last and widest write channel. The
// reviewer committed a "test" that forged router state and the run was still recorded PASSED:
// `{"dispatchStatus":0,"verifier":"PASSED","stateTampering":[],"forgedResultExists":true}`.
test('a verify command that forges router state fails the run instead of passing it', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const prev = process.env.ROUTER_CODEX_BIN;
  process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    // The forgery runs as the project's own verification command -- i.e. as code the executor
    // committed and router then executes on its behalf.
    const forge =
      "require('node:fs').mkdirSync('.router/tasks/forged',{recursive:true});" +
      "require('node:fs').writeFileSync('.router/tasks/forged/result.json'," +
      'JSON.stringify({task_id:"forged",exit_class:"ok",verifier:{result:"PASSED",checks:[]}}));';
    stageTask(
      paths,
      `schema_version: 1\nid: t1\ntitle: demo\nbase_sha: null\nmax_wall_minutes: 1\n` +
        `allowed_globs: ["src/**"]\nverify:\n  - [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(forge)}]\n`,
    );
    const result = await dispatchTask(deps, 't1');

    assert.equal(result.exit_class, 'task_failed', `a forging verify command passed: ${JSON.stringify(result)}`);
    assert.ok(result.state_tampering !== undefined, 'the forgery during verification went unseen');
    assert.ok(
      result.state_tampering.some((line) => line.includes('tasks/forged/result.json')),
      result.state_tampering.join(' | '),
    );
    // And no verdict survives: the evidence came from a checkout something else was writing.
    assert.equal(result.verifier, undefined, 'a PASSED verdict survived a state violation');
    assert.equal(result.verified_head, undefined);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    fx.cleanup(repo);
  }
});

for (const mutation of [
  {
    name: 'pid',
    source: 'record.pid = record.pid + 100000;',
    change: 'modified',
  },
  {
    name: 'owner_token',
    source: 'record.owner_token = "forged-owner";',
    change: 'modified',
  },
  {
    name: 'status_path',
    source: 'record.status_path = "/tmp/forged-status.json";',
    change: 'modified',
  },
  {
    name: 'whole record deletion',
    source: 'unlinkSync(activityPath);',
    change: 'deleted',
  },
] as const) {
  test(`forging the task activity ${mutation.name} is fatal`, async () => {
    const { repo, paths, deps } = setup();
    const activityPath = paths.activity(activityKey('task:t1'));
    const forger = join(repo, `fake-activity-${mutation.name.replaceAll(' ', '-')}.mjs`);
    writeFileSync(
      forger,
      '#!/usr/bin/env node\n' +
        "import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';\n" +
        "import {execFileSync} from 'node:child_process';\n" +
        'writeFileSync("src/a.ts","export const x = 2;\\n");\n' +
        'execFileSync("git",["add","--","src/a.ts"]);\n' +
        'execFileSync("git",["-c","user.name=f","-c","user.email=f@l","commit","-q","-m","fake: unit a"]);\n' +
        `const activityPath=${JSON.stringify(activityPath)};\n` +
        'const record=JSON.parse(readFileSync(activityPath,"utf8"));\n' +
        `${mutation.source}\n` +
        (mutation.change === 'modified'
          ? 'writeFileSync(activityPath,JSON.stringify(record,null,2)+"\\n");\n'
          : '') +
        'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
    );
    chmodSync(forger, 0o755);
    const prev = process.env.ROUTER_CODEX_BIN;
    const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
    process.env.ROUTER_CODEX_BIN = forger;
    process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
    try {
      stageTask(paths);
      const result = await dispatchTask(deps, 't1');
      const expected = `${mutation.change} activity/${activityKey('task:t1')}.json`;

      assert.equal(result.exit_class, 'task_failed');
      assert.deepEqual(result.state_tampering, [expected]);
      assert.equal(result.verifier, undefined);
    } finally {
      if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
      else process.env.ROUTER_CODEX_BIN = prev;
      if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
      else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
      fx.cleanup(repo);
    }
  });
}

test('editing a frozen plan is reported without failing the run', async () => {
  const { repo, paths, deps } = setup();
  const planPath = paths.workplanMd('p1');
  const editor = join(repo, 'fake-plan-editor.mjs');
  mkdirSync(paths.planDir('p1'), { recursive: true });
  writeFileSync(planPath, '# Before\n');
  writeFileSync(
    editor,
    '#!/usr/bin/env node\n' +
      "import {writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';\n" +
      'writeFileSync("src/a.ts","export const x = 2;\\n");\n' +
      'execFileSync("git",["add","--","src/a.ts"]);\n' +
      'execFileSync("git",["-c","user.name=f","-c","user.email=f@l","commit","-q","-m","fake: unit a"]);\n' +
      `writeFileSync(${JSON.stringify(planPath)},"# After\\n");\n` +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(editor, 0o755);
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = editor;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    stageTask(paths);
    const result = await dispatchTask(deps, 't1');

    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(result.state_tampering, undefined);
    assert.deepEqual(result.state_changes, ['modified plans/p1/WORKPLAN.md']);
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(repo);
  }
});

test('dispatch passes while a real supervised activity starts and finishes inside its state windows', async () => {
  const { repo, paths } = setup();
  const controlDir = join(paths.taskDir('t1'), 'logs');
  const executorReady = join(controlDir, 'executor-ready');
  const executorRelease = join(controlDir, 'executor-release');
  const verifyReady = join(controlDir, 'verify-ready');
  const verifyRelease = join(controlDir, 'verify-release');
  const supervisedRelease = join(controlDir, 'supervised-release');
  const executor = join(repo, 'fake-delayed-executor.mjs');
  const supervisedLabel = 'review:acceptance-11b';
  const supervisedPath = paths.activity(activityKey(supervisedLabel));
  const waitForFile = (path: string) =>
    `while(!fs.existsSync(${JSON.stringify(path)})){` +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}';
  const verifySource =
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(verifyReady)},'ready');` +
    waitForFile(verifyRelease);
  let owner: RunningDispatch | undefined;
  let supervised: Promise<Awaited<ReturnType<typeof superviseCommand>>> | undefined;

  try {
    writeFileSync(
      executor,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';import {spawnSync} from 'node:child_process';\n" +
        `fs.writeFileSync(${JSON.stringify(executorReady)},'ready');\n` +
        waitForFile(executorRelease) +
        `const run=spawnSync(${JSON.stringify(FAKE_CODEX)},process.argv.slice(2),{stdio:'inherit'});\n` +
        'process.exit(run.status??1);\n',
    );
    chmodSync(executor, 0o755);
    stageTask(
      paths,
      TASK_YAML.replace('verify: []', `verify:\n  - ${JSON.stringify([NODE, '-e', verifySource])}`),
    );
    owner = startTaskProcess(repo, paths, executor);
    await waitUntil(() => existsSync(executorReady));

    supervised = superviseCommand({
      paths,
      label: supervisedLabel,
      // Keep the observer's own output in router state. A root-level log would itself make the
      // checkout dirty and test the closeout invariant instead of activity coexistence.
      logPath: join(paths.taskDir('t1'), 'logs', 'acceptance-11b.log'),
      argv: [NODE, '-e', `const fs=require('node:fs');${waitForFile(supervisedRelease)}`],
      cwd: repo,
      env: process.env,
      activityHeartbeatIntervalMs: 40,
    });
    await waitUntil(() => readActivity(supervisedPath) !== null);
    writeFileSync(executorRelease, 'release');
    await waitUntil(
      () =>
        existsSync(verifyReady) ||
        owner?.child.exitCode !== null ||
        owner?.child.signalCode !== null,
    );
    assert.ok(
      existsSync(verifyReady),
      `dispatch exited before verification: stdout=${owner.stdout()} stderr=${owner.stderr()}`,
    );

    writeFileSync(supervisedRelease, 'release');
    const supervisedResult = await supervised;
    assert.equal(supervisedResult.exitCode, 0);
    assert.equal(existsSync(supervisedPath), false);
    writeFileSync(verifyRelease, 'release');

    const ended = await owner.done;
    assert.deepEqual(ended, { code: 0, signal: null }, owner.stderr());
    const output = JSON.parse(owner.stdout().trim()) as {
      exit_class?: string;
      verifier?: string;
      state_tampering?: string[];
      state_changes?: string[];
    };
    const activityRel = `activity/${activityKey(supervisedLabel)}.json`;
    assert.equal(output.exit_class, 'ok');
    assert.equal(output.verifier, 'PASSED');
    assert.equal(output.state_tampering, undefined);
    assert.deepEqual(output.state_changes?.filter((line) => line.endsWith(activityRel)), [
      `created ${activityRel}`,
      `deleted ${activityRel}`,
    ]);
  } finally {
    writeFileSync(executorRelease, 'release');
    writeFileSync(supervisedRelease, 'release');
    writeFileSync(verifyRelease, 'release');
    await supervised?.catch(() => undefined);
    if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill('SIGKILL');
    }
    fx.cleanup(repo);
  }
});

for (const mode of ['dispatch', 'resume'] as const) {
  for (const replacementOwner of ['next-owner', 'original-owner'] as const) {
    const legalRerun = replacementOwner === 'next-owner';
    test(
      legalRerun
        ? `${mode} allows a sequential same-label activity rerun across execution and verify`
        : `${mode} detects a cross-window activity replacement that reuses its owner token`,
      async () => {
    const { repo, paths } = setup();
    const externalLabel = `review:cross-window-${mode}-${replacementOwner}`;
    const externalRel = `activity/${activityKey(externalLabel)}.json`;
    const externalPath = paths.activity(activityKey(externalLabel));
    const confirmedPath = join(
      paths.taskDir('t1'),
      'logs',
      `${mode}-${replacementOwner}-rebuilt-before-verify`,
    );
    const executor = join(
      paths.taskDir('t1'),
      'logs',
      `${mode}-${replacementOwner}-delete-external.mjs`,
    );
    const original = JSON.stringify({
      label: externalLabel,
      owner_token: 'original-owner',
      pid: process.pid,
      started_at: '2026-08-25T00:00:00.000Z',
      beat_at: '2026-08-25T00:00:01.000Z',
    });
    const replacement = JSON.stringify({
      label: externalLabel,
      owner_token: replacementOwner,
      pid: process.pid,
      started_at: '2026-08-25T00:00:02.000Z',
      beat_at: '2026-08-25T00:00:03.000Z',
    });
    const verifySource =
      `const fs=require('node:fs');` +
      `if(!fs.existsSync(${JSON.stringify(confirmedPath)}))process.exit(91);` +
      `const record=JSON.parse(fs.readFileSync(${JSON.stringify(externalPath)},'utf8'));` +
      `if(record.owner_token!==${JSON.stringify(replacementOwner)})process.exit(92);`;
    let initial: RunningDispatch | undefined;
    let owner: RunningDispatch | undefined;
    let rebuilder: ReturnType<typeof setInterval> | undefined;
    let previousPatch: string | undefined;

    try {
      stageTask(
        paths,
        mode === 'dispatch'
          ? TASK_YAML.replace('verify: []', `verify:\n  - ${JSON.stringify([NODE, '-e', verifySource])}`)
          : TASK_YAML,
      );
      if (mode === 'resume') {
        initial = startTaskProcess(repo, paths, FAKE_CODEX);
        const initialExit = await initial.done;
        assert.deepEqual(initialExit, { code: 0, signal: null }, initial.stderr());
        const initialOutput = JSON.parse(initial.stdout().trim()) as Record<string, unknown>;
        assert.equal(initialOutput.exit_class, 'ok');
        previousPatch = readFileSync(paths.diffPatch('t1'), 'utf8');
        writeFileSync(
          paths.taskYaml('t1'),
          TASK_YAML.replace('verify: []', `verify:\n  - ${JSON.stringify([NODE, '-e', verifySource])}`),
        );
      }

      mkdirSync(paths.activityDir, { recursive: true });
      mkdirSync(join(paths.taskDir('t1'), 'logs'), { recursive: true });
      writeFileSync(externalPath, original);
      writeFileSync(
        executor,
        '#!/usr/bin/env node\n' +
          "import {spawnSync} from 'node:child_process';import {unlinkSync} from 'node:fs';\n" +
          `const run=spawnSync(${JSON.stringify(FAKE_CODEX)},process.argv.slice(2),{stdio:'inherit'});\n` +
          `unlinkSync(${JSON.stringify(externalPath)});\n` +
          'process.exit(run.status??1);\n',
      );
      chmodSync(executor, 0o755);
      rebuilder =
        mode === 'dispatch'
          ? rebuildActivityDuringGating(paths, externalPath, replacement, confirmedPath)
          : rebuildActivityAfterPatchChanges(
              paths,
              externalPath,
              replacement,
              confirmedPath,
              previousPatch!,
            );

      owner = startTaskProcess(
        repo,
        paths,
        executor,
        40,
        mode === 'resume' ? 'continue after the external activity changed' : undefined,
      );
      const ended = await owner.done;
      assert.deepEqual(ended, { code: 0, signal: null }, owner.stderr());
      assert.equal(existsSync(confirmedPath), true, 'the record was not rebuilt before verify');

      const output = JSON.parse(owner.stdout().trim()) as {
        exit_class?: string;
        verifier?: string;
        state_tampering?: string[];
        state_changes?: string[];
      };
      if (legalRerun) {
        assert.equal(output.exit_class, 'ok');
        assert.equal(output.verifier, 'PASSED');
        assert.equal(output.state_tampering, undefined);
        assert.deepEqual(output.state_changes, [
          `deleted ${externalRel}`,
          `modified ${externalRel}`,
        ]);
      } else {
        assert.equal(output.exit_class, 'task_failed');
        assert.equal(output.verifier, undefined);
        assert.deepEqual(output.state_tampering, [`modified ${externalRel}`]);
        assert.deepEqual(output.state_changes, [`deleted ${externalRel}`]);
      }
    } finally {
      if (rebuilder !== undefined) clearInterval(rebuilder);
      if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill('SIGKILL');
      }
      if (initial !== undefined && initial.child.exitCode === null && initial.child.signalCode === null) {
        initial.child.kill('SIGKILL');
      }
      fx.cleanup(repo);
    }
      },
    );
  }
}

for (const mode of ['dispatch', 'resume'] as const) {
  test(`${mode} rejects an in-place foreign activity identity edit under the same token`, async () => {
    const { repo, paths } = setup();
    const externalLabel = `review:in-place-${mode}`;
    const externalRel = `activity/${activityKey(externalLabel)}.json`;
    const externalPath = paths.activity(activityKey(externalLabel));
    const executor = join(paths.taskDir('t1'), 'logs', `${mode}-edit-external.mjs`);
    let initial: RunningDispatch | undefined;
    let owner: RunningDispatch | undefined;
    try {
      stageTask(paths);
      if (mode === 'resume') {
        initial = startTaskProcess(repo, paths, FAKE_CODEX);
        const initialExit = await initial.done;
        assert.deepEqual(initialExit, { code: 0, signal: null }, initial.stderr());
        const initialOutput = JSON.parse(initial.stdout().trim()) as Record<string, unknown>;
        assert.equal(initialOutput.exit_class, 'ok');
      }

      mkdirSync(paths.activityDir, { recursive: true });
      mkdirSync(join(paths.taskDir('t1'), 'logs'), { recursive: true });
      writeFileSync(
        externalPath,
        JSON.stringify({
          label: externalLabel,
          owner_token: 'same-owner',
          pid: process.pid,
          started_at: '2026-08-25T00:00:00.000Z',
          beat_at: '2026-08-25T00:00:01.000Z',
        }),
      );
      writeFileSync(
        executor,
        '#!/usr/bin/env node\n' +
          "import {spawnSync} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';\n" +
          `const run=spawnSync(${JSON.stringify(FAKE_CODEX)},process.argv.slice(2),{stdio:'inherit'});\n` +
          `const path=${JSON.stringify(externalPath)};\n` +
          'const record=JSON.parse(readFileSync(path,"utf8"));record.pid+=1;\n' +
          'writeFileSync(path,JSON.stringify(record));\n' +
          'process.exit(run.status??1);\n',
      );
      chmodSync(executor, 0o755);
      owner = startTaskProcess(
        repo,
        paths,
        executor,
        40,
        mode === 'resume' ? 'continue after the external identity edit' : undefined,
      );
      const ended = await owner.done;
      assert.deepEqual(ended, { code: 0, signal: null }, owner.stderr());
      const output = JSON.parse(owner.stdout().trim()) as {
        exit_class?: string;
        verifier?: string;
        state_tampering?: string[];
        state_changes?: string[];
      };
      assert.equal(output.exit_class, 'task_failed');
      assert.equal(output.verifier, undefined);
      assert.deepEqual(output.state_tampering, [`modified ${externalRel}`]);
      assert.equal(output.state_changes, undefined);
    } finally {
      if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill('SIGKILL');
      }
      if (initial !== undefined && initial.child.exitCode === null && initial.child.signalCode === null) {
        initial.child.kill('SIGKILL');
      }
      fx.cleanup(repo);
    }
  });
}

test('resume reports a reviewer spanning both state windows once per transition and still passes', async () => {
  const { repo, paths } = setup();
  const controlDir = join(paths.taskDir('t1'), 'logs');
  const executorReady = join(controlDir, 'resume-executor-ready');
  const executorRelease = join(controlDir, 'resume-executor-release');
  const verifyReady = join(controlDir, 'resume-verify-ready');
  const verifyRelease = join(controlDir, 'resume-verify-release');
  const supervisedRelease = join(controlDir, 'resume-supervised-release');
  const executor = join(controlDir, 'fake-delayed-resume-executor.mjs');
  const supervisedLabel = 'review:resume-cross-window';
  const supervisedPath = paths.activity(activityKey(supervisedLabel));
  const waitForFile = (path: string) =>
    `while(!fs.existsSync(${JSON.stringify(path)})){` +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}';
  const verifySource =
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(verifyReady)},'ready');` +
    waitForFile(verifyRelease);
  let initial: RunningDispatch | undefined;
  let owner: RunningDispatch | undefined;
  let supervised: Promise<Awaited<ReturnType<typeof superviseCommand>>> | undefined;

  try {
    stageTask(paths);
    initial = startTaskProcess(repo, paths, FAKE_CODEX);
    const initialExit = await initial.done;
    assert.deepEqual(initialExit, { code: 0, signal: null }, initial.stderr());
    const initialOutput = JSON.parse(initial.stdout().trim()) as Record<string, unknown>;
    assert.equal(initialOutput.exit_class, 'ok');

    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      paths.taskYaml('t1'),
      TASK_YAML.replace('verify: []', `verify:\n  - ${JSON.stringify([NODE, '-e', verifySource])}`),
    );
    writeFileSync(
      executor,
      '#!/usr/bin/env node\n' +
        "import fs from 'node:fs';import {spawnSync} from 'node:child_process';\n" +
        `fs.writeFileSync(${JSON.stringify(executorReady)},'ready');\n` +
        waitForFile(executorRelease) +
        `const run=spawnSync(${JSON.stringify(FAKE_CODEX)},process.argv.slice(2),{stdio:'inherit'});\n` +
        'process.exit(run.status??1);\n',
    );
    chmodSync(executor, 0o755);
    owner = startTaskProcess(repo, paths, executor, 40, 'continue with reviewer overlap');
    await waitUntil(() => existsSync(executorReady));

    supervised = superviseCommand({
      paths,
      label: supervisedLabel,
      logPath: join(controlDir, 'resume-cross-window.log'),
      argv: [NODE, '-e', `const fs=require('node:fs');${waitForFile(supervisedRelease)}`],
      cwd: repo,
      env: process.env,
      activityHeartbeatIntervalMs: 40,
    });
    await waitUntil(() => readActivity(supervisedPath) !== null);
    writeFileSync(executorRelease, 'release');
    await waitUntil(
      () =>
        existsSync(verifyReady) ||
        owner?.child.exitCode !== null ||
        owner?.child.signalCode !== null,
    );
    assert.ok(
      existsSync(verifyReady),
      `resume exited before verification: stdout=${owner.stdout()} stderr=${owner.stderr()}`,
    );

    writeFileSync(supervisedRelease, 'release');
    const supervisedResult = await supervised;
    assert.equal(supervisedResult.exitCode, 0);
    assert.equal(existsSync(supervisedPath), false);
    writeFileSync(verifyRelease, 'release');

    const ended = await owner.done;
    assert.deepEqual(ended, { code: 0, signal: null }, owner.stderr());
    const output = JSON.parse(owner.stdout().trim()) as {
      exit_class?: string;
      verifier?: string;
      state_tampering?: string[];
      state_changes?: string[];
    };
    const activityRel = `activity/${activityKey(supervisedLabel)}.json`;
    assert.equal(output.exit_class, 'ok');
    assert.equal(output.verifier, 'PASSED');
    assert.equal(output.state_tampering, undefined);
    assert.deepEqual(output.state_changes?.filter((line) => line.endsWith(activityRel)), [
      `created ${activityRel}`,
      `deleted ${activityRel}`,
    ]);
    assert.equal(new Set(output.state_changes).size, output.state_changes?.length);
  } finally {
    writeFileSync(executorRelease, 'release');
    writeFileSync(supervisedRelease, 'release');
    writeFileSync(verifyRelease, 'release');
    await supervised?.catch(() => undefined);
    if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill('SIGKILL');
    }
    if (initial !== undefined && initial.child.exitCode === null && initial.child.signalCode === null) {
      initial.child.kill('SIGKILL');
    }
    fx.cleanup(repo);
  }
});

test('dispatch refuses an activity owned by supervise without overwriting or deleting it', async () => {
  const { repo, paths, deps } = setup();
  const label = 'task:t1';
  const activityPath = paths.activity(activityKey(label));
  const releasePath = join(repo, 'release-supervised-task-label');
  const supervised = superviseCommand({
    paths,
    label,
    logPath: join(repo, 'supervised-task-label.log'),
    argv: [
      NODE,
      '-e',
      `const fs=require('node:fs');while(!fs.existsSync(${JSON.stringify(releasePath)})){` +
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`,
    ],
    cwd: repo,
    env: process.env,
    activityHeartbeatIntervalMs: 40,
  });

  try {
    stageTask(paths);
    await waitUntil(() => readActivity(activityPath) !== null);
    const original = readActivity(activityPath);
    assert.ok(original);

    await assert.rejects(dispatchTask(deps, 't1'), (error: unknown) => {
      assert.ok(error instanceof ActivityAlreadyExistsError, String(error));
      assert.equal(error.activity?.owner_token, original.owner_token);
      assert.match(error.message, new RegExp(`pid ${process.pid}`));
      return true;
    });

    const afterRefusal = readActivity(activityPath);
    assert.ok(afterRefusal);
    assert.equal(afterRefusal.owner_token, original.owner_token);
    assert.equal(activityState(afterRefusal), 'running');
    assert.equal(existsSync(paths.runStatus('t1')), false, 'dispatch wrote status before claiming its activity');
    assert.equal(currentBranch(repo), 'main');

    writeFileSync(releasePath, 'release');
    const result = await supervised;
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(activityPath), false);
  } finally {
    writeFileSync(releasePath, 'release');
    await supervised.catch(() => undefined);
    fx.cleanup(repo);
  }
});

test('an independent process observes running heartbeats strictly inside the spawnSync verify window', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths } = setup();
  const observerDir = join(paths.taskDir('t1'), 'logs');
  const verifyGo = join(observerDir, 'verify-go');
  const verifyWindow = join(observerDir, 'verify-window.json');
  const watcherReady = join(observerDir, 'watcher-ready');
  const watcherStop = join(observerDir, 'watcher-stop');
  const samples = join(observerDir, 'activity-samples.jsonl');
  const activityPath = paths.activity(activityKey('task:t1'));
  const verifySource =
    `const fs=require('node:fs');` +
    `while(!fs.existsSync(${JSON.stringify(verifyGo)})){` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}` +
    `const blockedFrom=Date.now();` +
    `fs.writeFileSync(${JSON.stringify(verifyWindow)},JSON.stringify({blockedFrom}));` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);` +
    `const blockedUntil=Date.now();` +
    `fs.writeFileSync(${JSON.stringify(verifyWindow)},JSON.stringify({blockedFrom,blockedUntil}));`;
  let owner: RunningDispatch | undefined;
  let watcher: ChildProcess | undefined;

  try {
    stageTask(
      paths,
      TASK_YAML.replace('verify: []', `verify:\n  - ${JSON.stringify([NODE, '-e', verifySource])}`),
    );
    mkdirSync(observerDir, { recursive: true });
    owner = startTaskProcess(repo, paths, FAKE_CODEX);
    await waitUntil(() => readActivity(activityPath) !== null);
    const initial = readActivity(activityPath);
    assert.ok(initial);
    assert.equal(initial.label, 'task:t1');
    assert.equal(initial.pid, owner.child.pid);
    assert.equal(initial.status_path, paths.runStatus('t1'));

    const watcherSource =
      `const fs=await import('node:fs');` +
      `const {readActivity,activityState}=await import(${JSON.stringify(ACTIVITY_MODULE)});` +
      `fs.writeFileSync(${JSON.stringify(watcherReady)},'ready');` +
      `const timer=setInterval(()=>{` +
      `const record=readActivity(${JSON.stringify(activityPath)});` +
      `if(record!==null){fs.appendFileSync(${JSON.stringify(samples)},` +
      `JSON.stringify([Date.now(),record.beat_at,activityState(record)])+'\\n');}` +
      `if(fs.existsSync(${JSON.stringify(watcherStop)})){clearInterval(timer);process.exit(0);}` +
      `},15);` +
      `setTimeout(()=>{clearInterval(timer);process.exit(1)},8000);`;
    watcher = spawn(NODE, ['--input-type=module', '-e', watcherSource], { stdio: 'ignore' });
    await waitUntil(() => existsSync(watcherReady));
    writeFileSync(verifyGo, 'go');

    let window: { blockedFrom: number; blockedUntil: number } | undefined;
    await waitUntil(() => {
      try {
        const value = JSON.parse(readFileSync(verifyWindow, 'utf8')) as Partial<{
          blockedFrom: number;
          blockedUntil: number;
        }>;
        if (typeof value.blockedFrom !== 'number' || typeof value.blockedUntil !== 'number') return false;
        window = { blockedFrom: value.blockedFrom, blockedUntil: value.blockedUntil };
        return true;
      } catch {
        return false;
      }
    });
    writeFileSync(watcherStop, 'stop');
    const watcherExit = await waitForExit(watcher);
    assert.deepEqual(watcherExit, { code: 0, signal: null });

    assert.ok(window);
    const completedWindow = window;
    const rows = readFileSync(samples, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as [number, string, string]);
    const insideVerifyBlock = rows.filter(
      ([sampledAt]) =>
        sampledAt > completedWindow.blockedFrom && sampledAt < completedWindow.blockedUntil,
    );
    assert.ok(
      insideVerifyBlock.length > 5,
      `independent watcher barely sampled the verify block (${insideVerifyBlock.length})`,
    );
    assert.deepEqual(
      new Set(insideVerifyBlock.map(([, , state]) => state)),
      new Set(['running']),
      'the external liveness decision changed during synchronous verification',
    );
    const beatsInsideBlock = new Set(insideVerifyBlock.map(([, beatAt]) => beatAt));
    assert.ok(
      beatsInsideBlock.size >= 2,
      `only ${beatsInsideBlock.size} distinct beat_at values landed inside spawnSync verification`,
    );

    const ended = await owner.done;
    assert.deepEqual(ended, { code: 0, signal: null }, owner.stderr());
    const output = JSON.parse(owner.stdout().trim()) as Record<string, unknown>;
    assert.equal(output.exit_class, 'ok');
    assert.equal(output.verifier, 'PASSED');
    assert.equal(output.state_tampering, undefined);
    assert.equal(existsSync(activityPath), false, 'normal dispatch left an activity behind');
  } finally {
    if (watcher !== undefined && watcher.exitCode === null && watcher.signalCode === null) {
      watcher.kill('SIGKILL');
    }
    if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill('SIGKILL');
    }
    fx.cleanup(repo);
  }
});

test('resume publishes the same task activity and removes it after normal closeout', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths } = setup();
  const activityPath = paths.activity(activityKey('task:t1'));
  const delayedExecutor = join(paths.taskDir('t1'), 'logs', 'delayed-resume.mjs');
  let initial: RunningDispatch | undefined;
  let resumed: RunningDispatch | undefined;

  try {
    stageTask(paths);
    initial = startTaskProcess(repo, paths, FAKE_CODEX);
    const initialExit = await initial.done;
    assert.deepEqual(initialExit, { code: 0, signal: null }, initial.stderr());
    assert.equal(existsSync(activityPath), false);

    mkdirSync(join(paths.taskDir('t1'), 'logs'), { recursive: true });
    writeFileSync(
      delayedExecutor,
      `#!/usr/bin/env node\n` +
        `import {spawnSync} from 'node:child_process';\n` +
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);\n` +
        `const run=spawnSync(${JSON.stringify(FAKE_CODEX)},process.argv.slice(2),{stdio:'inherit'});\n` +
        `process.exit(run.status??1);\n`,
    );
    chmodSync(delayedExecutor, 0o755);
    resumed = startTaskProcess(repo, paths, delayedExecutor, 40, 'tighten it');
    await waitUntil(() => readActivity(activityPath) !== null);

    const activity = readActivity(activityPath);
    assert.ok(activity);
    assert.equal(activity.label, 'task:t1');
    assert.equal(activity.pid, resumed.child.pid);
    assert.equal(activity.status_path, paths.runStatus('t1'));
    assert.equal(activityState(activity), 'running');

    const resumedExit = await resumed.done;
    assert.deepEqual(resumedExit, { code: 0, signal: null }, resumed.stderr());
    const output = JSON.parse(resumed.stdout().trim()) as Record<string, unknown>;
    assert.equal(output.exit_class, 'ok');
    assert.equal(output.verifier, 'PASSED');
    assert.equal(output.state_tampering, undefined);
    assert.equal(existsSync(activityPath), false, 'normal resume left an activity behind');
  } finally {
    if (resumed !== undefined && resumed.child.exitCode === null && resumed.child.signalCode === null) {
      resumed.child.kill('SIGKILL');
    }
    if (initial !== undefined && initial.child.exitCode === null && initial.child.signalCode === null) {
      initial.child.kill('SIGKILL');
    }
    fx.cleanup(repo);
  }
});

test('activity cleanup retries, reports failure, and never replaces a successful dispatch result', async () => {
  chmodSync(FAKE_CODEX, 0o755);
  const { repo, paths, deps } = setup();
  const activityPath = paths.activity(activityKey('task:t1'));
  const mutableFs = createRequire(import.meta.url)('node:fs') as {
    unlinkSync(path: string): void;
  };
  const originalUnlink = mutableFs.unlinkSync;
  const diagnostics: string[] = [];
  let cleanupAttempts = 0;
  const prev = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;

  try {
    stageTask(paths);
    process.env.ROUTER_CODEX_BIN = FAKE_CODEX;
    process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
    mutableFs.unlinkSync = (path: string): void => {
      if (path === activityPath) {
        cleanupAttempts += 1;
        throw Object.assign(new Error('EPERM injected activity cleanup failure'), { code: 'EPERM' });
      }
      originalUnlink(path);
    };
    syncBuiltinESMExports();

    const result = await dispatchTask(
      { ...deps, activityDiagnostic: (message) => diagnostics.push(message) },
      't1',
    );

    assert.equal(result.exit_class, 'ok');
    assert.equal(result.verifier?.result, 'PASSED');
    assert.equal(cleanupAttempts, 3, 'dispatch did not retry an owner-safe activity cleanup');
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!, /could not remove activity.*EPERM injected activity cleanup failure/);
    const remnant = readActivity(activityPath);
    assert.ok(remnant);
    assert.equal(remnant.pid, process.pid);
    assert.equal(activityState(remnant), 'running');
  } finally {
    mutableFs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    if (existsSync(activityPath)) originalUnlink(activityPath);
    if (prev === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prev;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
    fx.cleanup(repo);
  }
});

test('SIGKILL leaves dispatch disconnected within the stale threshold without claiming a phase', async () => {
  const { repo, paths } = setup();
  const activityPath = paths.activity(activityKey('task:t1'));
  const workerPidPath = join(paths.taskDir('t1'), 'logs', 'killed-worker.pid');
  const hangingExecutor = join(repo, 'fake-hanging-executor.mjs');
  let owner: RunningDispatch | undefined;
  let workerPid: number | undefined;

  try {
    stageTask(paths);
    writeFileSync(
      hangingExecutor,
      `#!/usr/bin/env node\n` +
        `import {mkdirSync,writeFileSync} from 'node:fs';\n` +
        `import {dirname} from 'node:path';\n` +
        `mkdirSync(dirname(${JSON.stringify(workerPidPath)}),{recursive:true});\n` +
        `writeFileSync(${JSON.stringify(workerPidPath)},String(process.pid));\n` +
        `setInterval(()=>{},1000);\n`,
    );
    chmodSync(hangingExecutor, 0o755);
    owner = startTaskProcess(repo, paths, hangingExecutor);
    await waitUntil(() => readActivity(activityPath) !== null && existsSync(workerPidPath));
    workerPid = Number(readFileSync(workerPidPath, 'utf8'));

    const running = readActivity(activityPath);
    assert.ok(running);
    assert.equal(running.pid, owner.child.pid);
    assert.equal(running.status_path, paths.runStatus('t1'));
    assert.equal(activityState(running), 'running');
    const statusBeforeKill = JSON.parse(readFileSync(paths.runStatus('t1'), 'utf8')) as {
      phase?: string;
    };
    assert.equal(statusBeforeKill.phase, 'executor_working');
    const rawRunning = JSON.parse(readFileSync(activityPath, 'utf8')) as Record<string, unknown>;
    assert.equal('phase' in rawRunning, false, 'dispatch copied phase into the activity record');

    const killedAt = Date.now();
    owner.child.kill('SIGKILL');
    const ended = await owner.done;
    assert.equal(ended.signal, 'SIGKILL');
    await waitUntil(() => activityState(readActivity(activityPath)) === 'disconnected');
    assert.ok(Date.now() - killedAt < DEFAULT_STALE_MS, 'disconnect detection exceeded the shared threshold');

    const disconnected = readActivity(activityPath);
    assert.ok(disconnected);
    assert.equal(activityState(disconnected), 'disconnected');
    assert.equal(disconnected.pid, owner.child.pid);
    const rawDisconnected = JSON.parse(readFileSync(activityPath, 'utf8')) as Record<string, unknown>;
    assert.equal('phase' in rawDisconnected, false, 'the on-disk disconnected activity claimed a phase');
    assert.equal(existsSync(activityPath), true, 'SIGKILL unexpectedly ran normal activity cleanup');
    // The richer status file is intentionally left untouched; consumers may follow it only for
    // running activities. Exercise the real activity projection rather than reproducing that
    // decision in this test.
    const staleStatus = JSON.parse(readFileSync(disconnected.status_path!, 'utf8')) as { phase?: string };
    assert.equal(staleStatus.phase, 'executor_working');
    const projected = observeActivities(paths.activityDir);
    assert.equal(projected.length, 1);
    assert.equal(projected[0]!.state, 'disconnected');
    assert.equal(projected[0]!.record.owner_token, disconnected.owner_token);
  } finally {
    if (owner !== undefined && owner.child.exitCode === null && owner.child.signalCode === null) {
      owner.child.kill('SIGKILL');
    }
    if (workerPid !== undefined) killProcessGroup(workerPid);
    fx.cleanup(repo);
  }
});
