// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedClock } from '../src/io/clock.ts';
import { routerPaths } from '../src/io/paths.ts';
import { RunStatusWriter, terminalStateFor } from '../src/app/runStatus.ts';
import { prepareRun, runPrepared } from '../src/app/dispatch.ts';
import type { MetricRecord, RunStatus } from '../src/domain/types.ts';
import { readJsonl } from '../src/io/jsonl.ts';
import * as fx from '../testkit/gitRepo.ts';

const RUN = 'run-001';

function readStatus(path: string): RunStatus {
  return JSON.parse(readFileSync(path, 'utf8')) as RunStatus;
}

function tempStatus(): { dir: string; path: string; worktree: string } {
  const dir = mkdtempSync(join(tmpdir(), 'router-status-'));
  const path = join(dir, 'runs', RUN, 'status.json');
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  return { dir, path, worktree };
}

test('phase and terminal state remain separate and phase durations use the monotonic clock', () => {
  const { dir, path, worktree } = tempStatus();
  const clock = fixedClock('2026-08-12T00:00:00.000Z');
  try {
    const status = new RunStatusWriter({ path, workDir: worktree, budgetMinutes: 30, clock });
    assert.deepEqual(readStatus(path), {
      phase: 'queued',
      started_at: '2026-08-12T00:00:00.000Z',
      phase_started_at: '2026-08-12T00:00:00.000Z',
      budget_minutes: 30,
      last_output_at: null,
      stall_deadline: null,
    });

    status.transition('worktree');
    clock.advanceMs(1_250);
    status.executorStarting(60_000);
    clock.advanceMs(250);
    status.transition('executor_working', 60_000);
    clock.advanceMs(2_500);
    status.transition('gating');
    clock.advanceMs(500);
    status.transition('verify');
    clock.advanceMs(750);
    const timings = status.terminal('succeeded');

    const terminal = readStatus(path);
    assert.equal(terminal.phase, 'verify');
    assert.equal(terminal.terminal_state, 'succeeded');
    assert.equal(terminal.last_output_at, null);
    assert.equal(terminal.stall_deadline, null);
    assert.deepEqual(timings, {
      t_worktree: 1.25,
      t_launch: 0.25,
      t_exec: 2.5,
      t_gate: 0.5,
      t_verify: 0.75,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity writes are merged and throttled to one write per two-second window', () => {
  const { dir, path, worktree } = tempStatus();
  const clock = fixedClock('2026-08-12T00:00:00.000Z');
  let writes = 0;
  try {
    const status = new RunStatusWriter({
      path,
      workDir: worktree,
      budgetMinutes: 10,
      clock,
      activityThrottleMs: 2_000,
      onWrite: () => {
        writes += 1;
      },
    });
    status.executorStarting(60_000);
    status.transition('executor_working', 60_000);
    const phaseWrites = writes;

    status.noteOutput('{"type":"system"}', 'claude');
    status.noteOutput('{"type":"system"}', 'claude');
    status.noteOutput('{"type":"system"}', 'claude');
    assert.equal(writes - phaseWrites, 1);

    clock.advanceMs(1_999);
    status.noteOutput('{"type":"system"}', 'claude');
    assert.equal(writes - phaseWrites, 1);
    clock.advanceMs(1);
    status.noteOutput('{"type":"system"}', 'claude');
    assert.equal(writes - phaseWrites, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude recent_action retains only allowlisted redacted tool metadata', () => {
  const { dir, path, worktree } = tempStatus();
  const clock = fixedClock('2026-08-12T00:00:00.000Z');
  const secret = 'FAKE_SECRET_987654';
  try {
    const status = new RunStatusWriter({ path, workDir: worktree, budgetMinutes: 10, clock });
    status.executorStarting(60_000);
    status.transition('executor_working', 60_000);
    status.noteOutput(
      JSON.stringify({
        type: 'assistant',
        free_text: `never persist ${secret}`,
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: `git status --porcelain --token ${secret}` },
            },
          ],
        },
      }),
      'claude',
    );
    let raw = readFileSync(path, 'utf8');
    assert.equal(readStatus(path).recent_action, 'Bash: git status');
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.doesNotMatch(raw, /--porcelain|--token/);

    clock.advanceMs(2_000);
    status.noteOutput(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${secret}` } }] },
      }),
      'claude',
    );
    raw = readFileSync(path, 'utf8');
    assert.equal(readStatus(path).recent_action, 'Bash: echo');
    assert.doesNotMatch(raw, new RegExp(secret));

    clock.advanceMs(2_000);
    status.noteOutput(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: {
                file_path: join(worktree, 'src', 'safe.ts'),
                old_string: secret,
                new_string: `replacement ${secret}`,
              },
            },
          ],
        },
      }),
      'claude',
    );
    raw = readFileSync(path, 'utf8');
    assert.equal(readStatus(path).recent_action, 'Edit: src/safe.ts');
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.doesNotMatch(raw, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic replacement never exposes a partial status document to a concurrent reader', async () => {
  const { dir, path, worktree } = tempStatus();
  const donePath = join(dir, 'done');
  const clock = fixedClock('2026-08-12T00:00:00.000Z');
  try {
    const status = new RunStatusWriter({ path, workDir: worktree, budgetMinutes: 10, clock });
    const readerScript =
      'const fs=require("node:fs");const p=process.argv[1],done=process.argv[2];let reads=0;' +
      'function tick(){try{JSON.parse(fs.readFileSync(p,"utf8"));reads++;}catch(e){' +
      'process.stderr.write(String(e));process.exit(2);return}' +
      'if(fs.existsSync(done)){process.stdout.write(String(reads));process.exit(0);return}' +
      'setImmediate(tick)}tick();';
    const child = spawn(process.execPath, ['-e', readerScript, path, donePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    for (let i = 0; i < 200; i++) {
      clock.advanceMs(1);
      status.transition(i % 2 === 0 ? 'worktree' : 'gating');
    }
    writeFileSync(donePath, 'done');
    const exitCode = await new Promise<number | null>((resolveExit) => child.on('exit', resolveExit));
    assert.equal(exitCode, 0, stderr);
    assert.ok(Number(stdout) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Scenario = 'success' | 'task_failed' | 'timeout' | 'stall';

async function dispatchScenario(scenario: Scenario): Promise<{
  status: RunStatus;
  metrics: MetricRecord[];
  cleanup(): void;
}> {
  const repo = fx.initRepo();
  fx.write(repo, 'src/a.ts', 'export const x = 1;\n');
  fx.write(repo, '.gitignore', '.router/worktrees/\n');
  fx.addCommit(repo, 'base');
  const paths = routerPaths(join(repo, '.router'));
  mkdirSync(paths.taskDir('status-task'), { recursive: true });
  writeFileSync(
    paths.taskYaml('status-task'),
    `schema_version: 1
id: status-task
plan_id: 2026-08-12-go-execution-v2
plan_revision: "1"
title: status
base_sha: null
max_wall_minutes: 1
allowed_globs: ["src/**"]
worker: {kind: codex}
verify: []
`,
  );
  writeFileSync(paths.contractMd('status-task'), '# Contract\n');

  const fake = join(repo, `fake-${scenario}.mjs`);
  const scripts: Record<Scenario, string> = {
    // Commits, because the contract requires it: dispatch has no catch-all commit any more, so a
    // fake that only wrote a file would end in the closing-invariant failure instead of success.
    success:
      '#!/usr/bin/env node\n' +
      'import {writeFileSync} from "node:fs";import {execFileSync} from "node:child_process";' +
      'writeFileSync("src/a.ts","export const x = 2;\\n");' +
      'execFileSync("git",["add","--","src/a.ts"]);' +
      'execFileSync("git",["-c","user.name=f","-c","user.email=f@l","commit","-q","-m","fake: unit a"]);' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");',
    task_failed: '#!/usr/bin/env node\nprocess.exit(7);\n',
    timeout: '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',
    stall: '#!/usr/bin/env node\nconsole.log("started");setInterval(()=>{},1000);\n',
  };
  writeFileSync(fake, scripts[scenario]);
  chmodSync(fake, 0o755);

  const prevBin = process.env.ROUTER_CODEX_BIN;
  const prevSessions = process.env.ROUTER_CODEX_SESSIONS_DIR;
  process.env.ROUTER_CODEX_BIN = fake;
  process.env.ROUTER_CODEX_SESSIONS_DIR = join(repo, 'no-sessions');
  try {
    const deps = { paths, clock: fixedClock('2026-08-12T00:00:00.000Z') };
    const prep = prepareRun(deps, 'status-task');
    if (scenario === 'timeout') prep.task.max_wall_minutes = 0.0025;
    if (scenario === 'stall') {
      prep.task.max_wall_minutes = 0.1;
      prep.workers[0]!.stall_minutes = 0.0025;
    }
    await runPrepared(deps, prep);
    return {
      status: readStatus(paths.runStatus('status-task')),
      metrics: readJsonl<MetricRecord>(paths.metrics),
      cleanup: () => fx.cleanup(repo),
    };
  } catch (error) {
    fx.cleanup(repo);
    throw error;
  } finally {
    if (prevBin === undefined) delete process.env.ROUTER_CODEX_BIN;
    else process.env.ROUTER_CODEX_BIN = prevBin;
    if (prevSessions === undefined) delete process.env.ROUTER_CODEX_SESSIONS_DIR;
    else process.env.ROUTER_CODEX_SESSIONS_DIR = prevSessions;
  }
}

test('dispatch writes terminal states for success, task failure, timeout, and stall', async () => {
  const expected = {
    success: terminalStateFor('ok', true),
    task_failed: terminalStateFor('task_failed', false),
    timeout: terminalStateFor('timeout', false),
    stall: terminalStateFor('stalled', false),
  } as const;

  for (const scenario of Object.keys(expected) as Scenario[]) {
    const observed = await dispatchScenario(scenario);
    try {
      assert.equal(observed.status.terminal_state, expected[scenario], scenario);
      assert.ok(observed.status.phase === 'verify' || observed.status.phase === 'executor_working');
      assert.equal(observed.metrics.length, 1);
      for (const key of ['t_worktree', 't_launch', 't_exec', 't_gate', 't_verify'] as const) {
        assert.equal(typeof observed.metrics[0]![key], 'number', `${scenario} ${key}`);
      }
    } finally {
      observed.cleanup();
    }
  }
});
