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
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_SCOPED = fileURLToPath(new URL('../testkit/fakeCodexScoped.mjs', import.meta.url));
const FAKE_DELIVERY = fileURLToPath(new URL('./fixtures/fakeCodexDelivery.mjs', import.meta.url));
const NODE = process.execPath;
const FAKE_EDIT_THEN_FAIL = fileURLToPath(new URL('../testkit/fakeCodexEditThenFail.mjs', import.meta.url));

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

test('dispatch -> land: synchronous run to a verified diff, then merge', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nworker:\n  kind: codex\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    // task.yaml default allowed_globs is src/**; fakeCodex edits src/a.ts.
    const d = router(dir, ['dispatch', 'demo', '--json'], env);
    assert.equal(d.code, 0, d.out);
    const out = JSON.parse(d.out);
    assert.equal(out.verifier, 'PASSED');
    assert.equal(out.executor, 'codex');
    // land merges the verified branch into the working tree.
    const l = router(dir, ['land', 'demo']);
    assert.equal(l.code, 0, l.out);
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /fake codex/);
    // land deletes the run branch, so it must hand back the merge commit -- the only
    // remaining handle on what the task changed.
    const sha = /-> ([0-9a-f]{12})/.exec(l.out)?.[1];
    assert.ok(sha !== undefined, `land output should carry the merge commit: ${l.out}`);
    assert.match(fx.git(dir, ['show', '--stat', sha]), /src\/a\.ts/);
    const landed = JSON.parse(readFileSync(join(dir, '.router', 'tasks', 'demo', 'runs', 'run-001', 'result.json'), 'utf8'));
    assert.match(landed.merge_commit, new RegExp(`^${sha}`));
  } finally {
    fx.cleanup(dir);
  }
});

test('policy-free + no init: dispatch uses the task-carried verify command', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base'); // NB: no .router, no policy.yaml, no `router init`
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    // `new` auto-scaffolds .router (no init needed); then author the task with a verify cmd.
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    writeFileSync(
      join(dir, '.router', 'tasks', 'demo', 'task.yaml'),
      `schema_version: 1\nid: demo\ntitle: Demo\nmax_wall_minutes: 1\nallowed_globs: ["src/**"]\nmax_changed_lines: 400\nverify: [[${JSON.stringify(NODE)}, "-e", "process.exit(0)"]]\n`,
    );
    const jsonLine = (out: string): Record<string, unknown> =>
      JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}');
    const ok = jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out);
    assert.equal(ok.verifier, 'PASSED');

    // a failing verify command -> FAILED (fresh id to avoid the prior run branch)
    router(dir, ['new', 'demo2', '--title', 'Demo2'], env);
    writeFileSync(
      join(dir, '.router', 'tasks', 'demo2', 'task.yaml'),
      `schema_version: 1\nid: demo2\ntitle: Demo2\nmax_wall_minutes: 1\nallowed_globs: ["src/**"]\nverify: [[${JSON.stringify(NODE)}, "-e", "process.exit(1)"]]\n`,
    );
    const bad = router(dir, ['dispatch', 'demo2', '--json'], env);
    assert.equal(bad.code, 1);
    assert.equal(jsonLine(bad.out).verifier, 'FAILED');
  } finally {
    fx.cleanup(dir);
  }
});

test('land refuses when there is no PASSED dispatch result', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.router/policy.yaml', `schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "0"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "0"]\n`);
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo']);
    const l = router(dir, ['land', 'demo']);
    assert.equal(l.code, 1);
    assert.match(l.out, /no dispatch result/);
  } finally {
    fx.cleanup(dir);
  }
});

test('dispatch rejects --max-parallel below one', () => {
  const dir = fx.initRepo();
  try {
    const d = router(dir, ['dispatch', 'demo', '--max-parallel', '0']);
    assert.equal(d.code, 2, d.out);
    assert.match(d.out, /--max-parallel must be an integer >= 1/);
  } finally {
    fx.cleanup(dir);
  }
});

test('dispatch persists delivery reports and surfaces header status', () => {
  chmodSync(FAKE_DELIVERY, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_DELIVERY, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    const dispatchJson = (id: string): Record<string, unknown> => {
      router(dir, ['new', id], env);
      const result = router(dir, ['dispatch', id, '--json'], env);
      assert.equal(result.code, 0, result.out);
      return JSON.parse(result.out) as Record<string, unknown>;
    };

    const missing = dispatchJson('delivery-missing');
    assert.equal(missing.delivery_header, 'missing');
    assert.match(String(missing.delivery), /\/\.router\/tasks\/delivery-missing\/runs\/run-001\/DELIVERY\.md$/);
    assert.equal(readFileSync(missing.delivery as string, 'utf8'), 'Delivery report for delivery-missing.');
    const missingPatch = readFileSync(
      join(dir, '.router', 'tasks', 'delivery-missing', 'runs', 'run-001', 'diff.patch'),
      'utf8',
    );
    assert.doesNotMatch(missingPatch, /DELIVERY\.md|Delivery report/);

    const valid = dispatchJson('delivery-valid');
    assert.equal(valid.delivery_header, 'ok');
    const validResult = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-valid', 'runs', 'run-001', 'result.json'), 'utf8'),
    ) as { delivery: { header: { task: string }; header_error?: string } };
    assert.equal(validResult.delivery.header.task, 'delivery-valid');
    assert.equal(validResult.delivery.header_error, undefined);

    const mismatch = dispatchJson('delivery-mismatch');
    assert.match(String(mismatch.delivery_header), /task mismatch/);
    const mismatchResult = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-mismatch', 'runs', 'run-001', 'result.json'), 'utf8'),
    ) as { verifier: { result: string }; delivery: { path: string; header_error: string } };
    assert.equal(mismatchResult.verifier.result, 'PASSED');
    assert.match(mismatchResult.delivery.header_error, /^task mismatch:/);
    assert.equal(readFileSync(mismatchResult.delivery.path, 'utf8').includes('another-task'), true);

    router(dir, ['new', 'delivery-plan-mismatch'], env);
    const planTask = join(dir, '.router', 'tasks', 'delivery-plan-mismatch', 'task.yaml');
    // The cross-check is against the declared REVISION, not the plan id: comparing the id to
    // itself could never disagree, which is why this check proved nothing before.
    writeFileSync(
      planTask,
      readFileSync(planTask, 'utf8').replace(
        'id: delivery-plan-mismatch\n',
        'id: delivery-plan-mismatch\nplan_id: expected-plan\nplan_revision: expected-revision\n',
      ),
    );
    const planMismatchRun = router(dir, ['dispatch', 'delivery-plan-mismatch', '--json'], env);
    assert.equal(planMismatchRun.code, 0, planMismatchRun.out);
    assert.match(String((JSON.parse(planMismatchRun.out) as Record<string, unknown>).delivery_header), /plan_revision mismatch/);

    router(dir, ['new', 'delivery-line'], env);
    const line = router(dir, ['dispatch', 'delivery-line'], env);
    assert.equal(line.code, 0, line.out);
    assert.match(line.out, / report: .*DELIVERY\.md \[delivery_header: missing\]$/m);
  } finally {
    fx.cleanup(dir);
  }
});

test('contract conflict overrides exit 0, creates no diff or verifier result, and cannot land', () => {
  chmodSync(FAKE_DELIVERY, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const base = fx.git(dir, ['rev-parse', 'HEAD']).trim();
  const env = { ROUTER_CODEX_BIN: FAKE_DELIVERY, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'contract-conflict'], env);
    const dispatch = router(dir, ['dispatch', 'contract-conflict', '--json'], env);
    assert.equal(dispatch.code, 1, dispatch.out);
    const out = JSON.parse(dispatch.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '{}') as Record<string, unknown>;
    assert.equal(out.exit_class, 'contract_conflict');
    assert.equal(out.conflict, true);
    // Never verified is not the same as verified-and-failed: a conflict skips the gate
    // entirely, so the machine-readable field is null rather than a dressed-up FAILED.
    assert.equal(out.verifier, null);
    assert.equal(out.commands_run, 1);

    const runDir = join(dir, '.router', 'tasks', 'contract-conflict', 'runs', 'run-001');
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(result.exit_class, 'contract_conflict');
    assert.equal(result.conflict, true);
    assert.equal('verifier' in result, false);
    assert.equal('diff_sha' in result, false);
    assert.equal(existsSync(join(runDir, 'diff.patch')), false);
    assert.match(readFileSync(join(runDir, 'DELIVERY.md'), 'utf8'), /^\s*CONTRACT_CONFLICT:/);
    assert.equal(fx.git(dir, ['rev-parse', 'router/contract-conflict/run-001']).trim(), base);
    const conflictMetric = JSON.parse(
      readFileSync(join(dir, '.router', 'metrics.jsonl'), 'utf8').trim().split('\n').at(-1) ?? '{}',
    ) as Record<string, unknown>;
    assert.equal(conflictMetric.conflict, true);
    assert.equal(conflictMetric.commands_run, 1);
    assert.equal('risk' in conflictMetric, false);

    const resumed = router(dir, ['resume', 'contract-conflict', '--feedback', 're-check the contract', '--json'], env);
    assert.equal(resumed.code, 1, resumed.out);
    const resumedOut = JSON.parse(
      resumed.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '{}',
    ) as Record<string, unknown>;
    assert.equal(resumedOut.exit_class, 'contract_conflict');
    const resumedResult = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(resumedResult.conflict, true);
    assert.equal('verifier' in resumedResult, false);
    assert.equal('diff_sha' in resumedResult, false);
    assert.equal(existsSync(join(runDir, 'diff.patch')), false);
    assert.equal(fx.git(dir, ['rev-parse', 'router/contract-conflict/run-001']).trim(), base);

    const land = router(dir, ['land', 'contract-conflict']);
    assert.equal(land.code, 1);
    assert.match(land.out, /contract conflict; refusing to land/);
    assert.match(land.out, /plan needs revising/);
    assert.match(land.out, /DELIVERY\.md/);

    router(dir, ['new', 'contract-conflict-line'], env);
    const line = router(dir, ['dispatch', 'contract-conflict-line'], env);
    assert.equal(line.code, 1);
    assert.match(line.out, /^contract-conflict-line: CONTRACT CONFLICT /);
    assert.match(line.out, /nothing committed or verified; the plan needs revising; report: .*DELIVERY\.md/);
  } finally {
    fx.cleanup(dir);
  }
});

test('dispatch reports deterministic risk escalation and writes routing metrics', () => {
  chmodSync(FAKE_DELIVERY, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_DELIVERY, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'risk-raised'], env);
    const taskPath = join(dir, '.router', 'tasks', 'risk-raised', 'task.yaml');
    const task = readFileSync(taskPath, 'utf8');
    writeFileSync(taskPath, `${task}tier: weak\nrisk: low\ninvariants: ["src/**"]\n`);

    const dispatch = router(dir, ['dispatch', 'risk-raised'], env);
    assert.equal(dispatch.code, 0, dispatch.out);
    assert.match(dispatch.out, /RISK RAISED to high: invariant:src\/\*\*/);

    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'risk-raised', 'runs', 'run-001', 'result.json'), 'utf8'),
    ) as { risk: string; risk_raised_by: string[]; commands_run: number };
    assert.equal(result.risk, 'high');
    assert.deepEqual(result.risk_raised_by, ['invariant:src/**']);
    assert.equal(result.commands_run, 1);

    const metrics = readFileSync(join(dir, '.router', 'metrics.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const metric = metrics.at(-1)!;
    assert.equal(metric.tier, 'weak');
    assert.equal(metric.effort, 'medium');
    assert.equal(metric.risk, 'high');
    assert.equal(metric.conflict, false);
    assert.equal(metric.commands_run, 1);
  } finally {
    fx.cleanup(dir);
  }
});

test('batch land merges PASSED tasks sequentially in the given order', () => {
  chmodSync(FAKE_SCOPED, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/base.ts', 'export const base = true;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_SCOPED, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    for (const id of ['p1', 'p2']) {
      router(dir, ['new', id], env);
      writeFileSync(
        join(dir, '.router', 'tasks', id, 'task.yaml'),
        `schema_version: 1\nid: ${id}\ntitle: ${id}\nmax_wall_minutes: 1\nallowed_globs: ["src/${id}.ts"]\nworker: {kind: codex}\nverify: []\n`,
      );
    }
    const d = router(dir, ['dispatch', 'p1', 'p2', '--json'], env);
    assert.equal(d.code, 0, d.out);
    const l = router(dir, ['land', 'p1', 'p2']);
    assert.equal(l.code, 0, l.out);
    assert.match(l.out, /^p1 landed /);
    assert.match(l.out, /\np2 landed /);
    assert.match(readFileSync(join(dir, 'src', 'p1.ts'), 'utf8'), /p1/);
    assert.match(readFileSync(join(dir, 'src', 'p2.ts'), 'utf8'), /p2/);
    assert.equal(fx.git(dir, ['log', '-2', '--pretty=%s']).trim(), "Merge branch 'router/p2/run-001'\nMerge branch 'router/p1/run-001'");
  } finally {
    fx.cleanup(dir);
  }
});

// A run killed before the gate could run must not be reported as a gate failure either.
test('dispatch --json reports verifier null when the gate never ran', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  // A fake executor that exits non-zero without editing anything: no commit, no verify.
  const env = { ROUTER_CODEX_BIN: FAKE_EDIT_THEN_FAIL, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'nogate'], env);
    const d = router(dir, ['dispatch', 'nogate', '--json'], env);
    assert.equal(d.code, 1, d.out);
    const out = JSON.parse(d.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '{}') as Record<string, unknown>;
    assert.equal(out.verifier, null);
    assert.equal(out.ok, false);
  } finally {
    fx.cleanup(dir);
  }
});
