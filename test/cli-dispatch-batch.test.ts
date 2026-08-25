// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...envExtra },
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function setup(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/base.ts', 'export const base = true;\n');
  fx.addCommit(dir, 'base');
  return dir;
}

// `apiKeyEnv` is the task's `worker.api_key_env`: the one explicit opt-in that lets a
// named variable through the executor environment allowlist (io/env.ts). The barrier
// fake needs its rendezvous directory, so the test smuggles it through that door.
function stageTask(dir: string, id: string, apiKeyEnv?: string): void {
  router(dir, ['new', id]);
  writeFileSync(
    join(dir, '.router', 'tasks', id, 'task.yaml'),
    `schema_version: 1
id: ${id}
title: ${id}
max_wall_minutes: 1
allowed_globs: ["src/${id}.ts"]
worker:
  kind: codex
${apiKeyEnv ? `  api_key_env: ${apiKeyEnv}\n` : ''}verify: []
`,
  );
}

// Was 'batch dispatch overlaps executor runs'. Overlapping is exactly what was removed, so the
// assertion is inverted: the runs must NOT overlap, proved from the recorded time windows rather
// than from the absence of a flag.
test('batch dispatch runs one task at a time, in input order', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: FAKE_SCOPED,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.equal(d.code, 0, d.out);
    const out = JSON.parse(d.out) as {
      ok: boolean;
      parallel?: number;
      results: { id: string; verifier: string; delivery: string | null; delivery_header: string }[];
    };
    assert.equal(out.ok, true);
    assert.equal(out.parallel, undefined, 'a pool size is still being reported');
    const windows = ['p1', 'p2'].map((id) =>
      JSON.parse(readFileSync(join(dir, '.router', 'tasks', id, 'result.json'), 'utf8')),
    );
    assert.ok(
      Date.parse(windows[1]!.started_at) >= Date.parse(windows[0]!.ended_at),
      `runs overlapped: ${windows[0]!.started_at}..${windows[0]!.ended_at} vs ${windows[1]!.started_at}`,
    );
    assert.deepEqual(out.results.map((result) => result.id), ['p1', 'p2']);
    assert.deepEqual(out.results.map((result) => result.verifier), ['PASSED', 'PASSED']);
    assert.deepEqual(out.results.map((result) => result.delivery), [null, null]);
    assert.deepEqual(out.results.map((result) => result.delivery_header), ['missing', 'missing']);
    // No worktrees at all now -- the whole batch ran in this one checkout.
    assert.equal(existsSync(join(dir, '.router', 'worktrees', 'p1')), false);
    assert.equal(existsSync(join(dir, '.router', 'worktrees', 'p2')), false);
    const branches = fx.git(dir, ['branch', '--format=%(refname:short)']);
    assert.match(branches, /^router\/p1$/m);
    assert.match(branches, /^router\/p2$/m);
    // Review finding 7: each task is cut from where the BATCH started, not from the previous
    // task's tip. Stacking was the earlier behaviour and the scope gate hid it -- p2's recorded
    // diff correctly held only its own files (computed from its own base_sha) while its BRANCH
    // held p1's commits, so `land p2` alone merged p1 too, past p1's review and past the
    // explicit land decision that belongs to the user.
    assert.equal(fx.git(dir, ['branch', '--show-current']).trim(), 'router/p2');
    const p1Tip = fx.git(dir, ['rev-parse', 'router/p1']).trim();
    assert.doesNotMatch(
      fx.git(dir, ['log', '--format=%H', 'router/p2']),
      new RegExp(p1Tip),
      'router/p2 contains p1 commits: landing p2 would silently land p1',
    );
    const metrics = readFileSync(join(dir, '.router', 'metrics.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(metrics.length, 2);
    assert.deepEqual(new Set(metrics.map((row: { task_id: string }) => row.task_id)), new Set(['p1', 'p2']));
  } finally {
    fx.cleanup(dir);
  }
});

test('batch dispatch keeps every task diff scoped to its own file', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: FAKE_SCOPED,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.equal(d.code, 0, d.out);
    for (const id of ['p1', 'p2']) {
      const other = id === 'p1' ? 'p2' : 'p1';
      const patch = readFileSync(join(dir, '.router', 'tasks', id, 'diff.patch'), 'utf8');
      assert.match(patch, new RegExp(`src/${id}\\.ts`));
      assert.doesNotMatch(patch, new RegExp(`src/${other}\\.ts`));
    }
  } finally {
    fx.cleanup(dir);
  }
});

// Rejected by name rather than ignored. Silently accepting a dead flag is how a caller ends up
// believing four executors ran when one did -- and this flag used to mean exactly that.
test('--max-parallel is refused, naming itself', () => {
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    const d = router(dir, ['dispatch', 'p1', '--max-parallel', '8']);
    assert.notEqual(d.code, 0);
    assert.match(d.out, /--max-parallel was removed; router dispatches one task at a time/);
  } finally {
    fx.cleanup(dir);
  }
});

test('batch land --json stays one document listing every merge', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  const env = { ROUTER_CODEX_BIN: FAKE_SCOPED, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    assert.equal(router(dir, ['dispatch', 'p1', 'p2', '--json'], env).code, 0);
    // Off the task branch first: choosing what to merge into is the user's decision.
    fx.git(dir, ['checkout', '-q', 'main']);
    // Landing ONLY p2 must bring only p2 (finding 7).
    const onlyP2 = router(dir, ['land', 'p2', '--json'], env);
    assert.equal(onlyP2.code, 0, onlyP2.out);
    assert.ok(existsSync(join(dir, 'src', 'p2.ts')));
    assert.ok(!existsSync(join(dir, 'src', 'p1.ts')), 'landing p2 also landed p1');

    const l = router(dir, ['land', 'p1', '--json'], env);
    assert.equal(l.code, 0, l.out);
    assert.equal(l.code, 0, l.out);
    const out = JSON.parse(l.out) as { ok: boolean; id: string; merge_commit: string };
    assert.equal(out.ok, true);
    assert.equal(out.id, 'p1');
    assert.match(out.merge_commit, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(dir, 'src', 'p1.ts')));
  } finally {
    fx.cleanup(dir);
  }
});

// Follow-up review, `batch-branch-contamination` still partial: the baseline was recorded as a
// branch NAME, so a batch started from a detached HEAD had `null` to restore and stacked exactly
// as before -- `router/p2` contained `router/p1`, and landing p2 alone landed p1 too. A detached
// HEAD is not exotic here: it is where `git checkout <sha>`, a bisect, and a rebase all leave you.
test('a batch started from a detached HEAD still cuts every task from the same base', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    fx.git(dir, ['checkout', '-q', '--detach', 'HEAD']);
    const detachedAt = fx.git(dir, ['rev-parse', 'HEAD']).trim();

    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: FAKE_SCOPED,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.equal(d.code, 0, d.out);

    const p1Tip = fx.git(dir, ['rev-parse', 'router/p1']).trim();
    assert.doesNotMatch(
      fx.git(dir, ['log', '--format=%H', 'router/p2']),
      new RegExp(p1Tip),
      'router/p2 contains p1 commits: landing p2 would silently land p1',
    );
    // Both branches hang off the commit the batch started at, not off each other.
    for (const id of ['p1', 'p2']) {
      const base = JSON.parse(
        readFileSync(join(dir, '.router', 'tasks', id, 'result.json'), 'utf8'),
      ) as { base_sha: string };
      assert.equal(base.base_sha, detachedAt, `${id} was not cut from the batch's starting commit`);
    }
  } finally {
    fx.cleanup(dir);
  }
});

// The other half of the same finding: restoring the baseline sat OUTSIDE the loop's try, so a
// starting branch deleted between tasks threw straight past the fault list -- no message naming
// which task stopped and why, and the user left standing on the previous task's branch.
test('a batch whose starting branch disappears fails by name, not by stack trace', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = setup();
  try {
    stageTask(dir, 'p1');
    stageTask(dir, 'p2');
    fx.git(dir, ['checkout', '-q', '-b', 'scratch']);
    // An executor that deletes the starting branch after committing its unit -- i.e. exactly
    // between the two tasks, which is the window the finding is about.
    const saboteur = join(dir, 'saboteur.mjs');
    writeFileSync(
      saboteur,
      '#!/usr/bin/env node\n' +
        "import { execFileSync } from 'node:child_process';\n" +
        "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
        "const prompt = process.argv.slice(2).find((a) => /^task: \\S+$/m.test(a)) ?? '';\n" +
        "const id = /^task: (\\S+)$/m.exec(prompt)?.[1] ?? 'p1';\n" +
        "mkdirSync('src', { recursive: true });\n" +
        'writeFileSync(`src/${id}.ts`, `export const ${id} = true;\\n`);\n' +
        'execFileSync("git", ["add", "--", `src/${id}.ts`]);\n' +
        'execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@l", "commit", "-q", "-m", `fake: ${id}`]);\n' +
        'try { execFileSync("git", ["branch", "-D", "scratch"], { stdio: "ignore" }); } catch {}\n' +
        'process.stdout.write(JSON.stringify({type:"thread.started",model:"fake-model-1",thread_id:`fake-session-${id}`})+"\\n");\n' +
        'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
    );
    chmodSync(saboteur, 0o755);

    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], {
      ROUTER_CODEX_BIN: saboteur,
      ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions'),
    });
    assert.notEqual(d.code, 0, d.out);
    // Names the task that could not start and why. The old path produced neither.
    assert.match(d.out, /p2/, d.out);
    assert.match(d.out, /scratch|checkout|pathspec|did not match/i, d.out);
    // And p2 never got a branch cut from the wrong base.
    assert.doesNotMatch(fx.git(dir, ['branch', '--format=%(refname:short)']), /^router\/p2$/m);
  } finally {
    fx.cleanup(dir);
  }
});
