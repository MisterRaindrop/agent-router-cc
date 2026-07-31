// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchTask } from '../src/app/dispatch.ts';
import { verifyTask, type TaskVerifyRequest } from '../src/app/verifier.ts';
import { fixedClock } from '../src/io/clock.ts';
import { routerPaths } from '../src/io/paths.ts';
import * as fx from '../testkit/gitRepo.ts';

const RUN = 'run-001';

function setupProbeRepo(): {
  repo: string;
  paths: ReturnType<typeof routerPaths>;
  deps: { paths: ReturnType<typeof routerPaths>; clock: ReturnType<typeof fixedClock> };
} {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const value = 1;\n');
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  mkdirSync(paths.taskDir('probe-task'), { recursive: true });
  writeFileSync(
    paths.taskYaml('probe-task'),
    `schema_version: 1
id: probe-task
title: Probe task
mode: probe
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
worker: {kind: codex}
verify: []
`,
  );
  writeFileSync(paths.contractMd('probe-task'), '# Probe\nAnswer the question without editing files.\n');
  return {
    repo,
    paths,
    deps: { paths, clock: fixedClock('2026-07-31T00:00:00.000Z') },
  };
}

function makeProbeExecutor(writeDiff: boolean): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'router-probe-executor-'));
  const path = join(dir, 'fake-probe.mjs');
  const report = `Probe delivery report.

\`\`\`router-delivery
task: probe-task
plan_revision: none
gate_ran: false
scope_drift: false
escalate_review: false
\`\`\``;
  const edit = writeDiff
    ? "writeFileSync('src/probe-result.ts', 'export const shouldNotExist = true;\\n');"
    : '';
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
${edit}
process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'probe-fake', thread_id: 'probe-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(report)} } }) + '\\n');
`,
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

async function withProbeExecutor(
  writeDiff: boolean,
  run: (setup: ReturnType<typeof setupProbeRepo>) => Promise<void>,
): Promise<void> {
  const setup = setupProbeRepo();
  const executor = makeProbeExecutor(writeDiff);
  const previousBin = process.env.ROUTER_CODEX_BIN;
  const previousSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = executor.path;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(setup.repo, 'no-sessions');
  try {
    await run(setup);
  } finally {
    if (previousBin === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = previousBin;
    if (previousSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = previousSessions;
    rmSync(executor.dir, { recursive: true, force: true });
    fx.cleanup(setup.repo);
  }
}

test('probe passes when its executor writes nothing and stores the delivery report', async () => {
  await withProbeExecutor(false, async ({ paths, deps }) => {
    const result = await dispatchTask(deps, 'probe-task');

    assert.equal(result.exit_class, 'ok');
    assert.deepEqual(result.verifier, {
      result: 'PASSED',
      checks: [{ id: 'probe_no_diff', ok: true }],
    });
    assert.equal(result.diff_sha, undefined);
    assert.equal(existsSync(paths.diffPatch('probe-task', RUN)), false);
    assert.ok(result.delivery);
    assert.match(readFileSync(paths.delivery('probe-task', RUN), 'utf8'), /^Probe delivery report/);
    assert.equal(fx.git(paths.worktree('probe-task', RUN), ['rev-parse', 'HEAD']).trim(), result.base_sha);
  });
});

test('probe fails with the file count when its executor writes code and leaves no diff patch', async () => {
  await withProbeExecutor(true, async ({ paths, deps }) => {
    mkdirSync(join(paths.runsDir('probe-task'), RUN), { recursive: true });
    writeFileSync(paths.diffPatch('probe-task', RUN), 'stale patch from an earlier run\n');
    const result = await dispatchTask(deps, 'probe-task');

    assert.equal(result.exit_class, 'ok');
    assert.deepEqual(result.verifier, {
      result: 'FAILED',
      checks: [{ id: 'probe_no_diff', ok: false, detail: 'probe wrote 1 file; expected no diff' }],
    });
    assert.equal(result.diff_sha, undefined);
    assert.equal(existsSync(paths.diffPatch('probe-task', RUN)), false);
    assert.ok(result.delivery);
  });
});

function verifyRequest(repo: string, baseSha: string): TaskVerifyRequest {
  return {
    repoRoot: repo,
    worktreeDir: repo,
    baseSha,
    head: 'HEAD',
    allowedGlobs: ['src/**'],
    verify: [],
    env: {},
  };
}

test('implement verification keeps the existing passing and scope-failure check order', () => {
  const passingRepo = fx.initRepo();
  const scopeRepo = fx.initRepo();
  try {
    fx.write(passingRepo, 'src/a.ts', 'export const value = 1;\n');
    const passingBase = fx.addCommit(passingRepo, 'base');
    fx.write(passingRepo, 'src/a.ts', 'export const value = 2;\n');
    fx.addCommit(passingRepo, 'change');

    const passingDefault = verifyTask(verifyRequest(passingRepo, passingBase));
    const passingImplement = verifyTask({ ...verifyRequest(passingRepo, passingBase), mode: 'implement' });
    assert.deepEqual(passingImplement, passingDefault);
    assert.deepEqual(passingImplement.checks.map((check) => check.id), [
      'diff_applies',
      'scope',
      'secret_scan',
      'exec_bit',
    ]);

    fx.write(scopeRepo, 'src/a.ts', 'export const value = 1;\n');
    const scopeBase = fx.addCommit(scopeRepo, 'base');
    fx.write(scopeRepo, 'outside.txt', 'out of scope\n');
    fx.addCommit(scopeRepo, 'change');

    const scopeDefault = verifyTask(verifyRequest(scopeRepo, scopeBase));
    const scopeImplement = verifyTask({ ...verifyRequest(scopeRepo, scopeBase), mode: 'implement' });
    assert.deepEqual(scopeImplement, scopeDefault);
    assert.deepEqual(scopeImplement.checks.map((check) => check.id), ['diff_applies', 'scope']);
    assert.equal(scopeImplement.result, 'FAILED');
  } finally {
    fx.cleanup(passingRepo);
    fx.cleanup(scopeRepo);
  }
});
