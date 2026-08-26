// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import { childEnv } from './childEnv.ts';
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
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: childEnv(envExtra) });
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
    // Dispatch leaves us standing on the task branch, so `land` refuses until we pick the
    // branch to merge INTO. That choice is deliberately the user's: merging is irreversible.
    assert.equal(fx.git(dir, ['branch', '--show-current']).trim(), 'router/demo');
    const refused = router(dir, ['land', 'demo']);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /you are on router\/demo, the branch to be landed/);

    // land merges the verified branch into the working tree.
    fx.git(dir, ['checkout', '-q', 'main']);
    const l = router(dir, ['land', 'demo']);
    assert.equal(l.code, 0, l.out);
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /fake codex/);
    // land deletes the run branch, so it must hand back the merge commit -- the only
    // remaining handle on what the task changed.
    const sha = /-> ([0-9a-f]{12})/.exec(l.out)?.[1];
    assert.ok(sha !== undefined, `land output should carry the merge commit: ${l.out}`);
    assert.match(fx.git(dir, ['show', '--stat', sha]), /src\/a\.ts/);
    const landed = JSON.parse(readFileSync(join(dir, '.router', 'tasks', 'demo', 'result.json'), 'utf8'));
    assert.match(landed.merge_commit, new RegExp(`^${sha}`));
    // No worktree is created any more, and land deletes the branch it merged.
    assert.equal(existsSync(join(dir, '.router', 'worktrees', 'demo')), false);
    assert.doesNotMatch(fx.git(dir, ['branch', '--format=%(refname:short)']), /^router\/demo$/m);
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

    // Back to our own branch first. Dispatch leaves us standing on `router/demo`, and starting
    // the next task from there would cut demo2's branch on top of demo's commits -- so its base
    // would already contain them and its diff would come out empty.
    fx.git(dir, ['checkout', '-q', 'main']);
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

test('dispatch refuses --max-parallel, which no longer exists', () => {
  const dir = fx.initRepo();
  try {
    router(dir, ['new', 'demo']);
    const d = router(dir, ['dispatch', 'demo', '--max-parallel', '0']);
    assert.notEqual(d.code, 0);
    assert.match(d.out, /--max-parallel was removed; router dispatches one task at a time/);
    // Also refused for a value that used to be legal -- the flag is gone, not validated.
    const two = router(dir, ['dispatch', 'demo', '--max-parallel', '2']);
    assert.notEqual(two.code, 0);
    assert.match(two.out, /--max-parallel was removed/);
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
    assert.match(String(missing.delivery), /\/\.router\/tasks\/delivery-missing\/DELIVERY\.md$/);
    assert.equal(readFileSync(missing.delivery as string, 'utf8'), 'Delivery report for delivery-missing.');
    const missingPatch = readFileSync(
      join(dir, '.router', 'tasks', 'delivery-missing', 'diff.patch'),
      'utf8',
    );
    assert.doesNotMatch(missingPatch, /DELIVERY\.md|Delivery report/);

    const valid = dispatchJson('delivery-valid');
    assert.equal(valid.delivery_header, 'ok');
    const validResult = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-valid', 'result.json'), 'utf8'),
    ) as { delivery: { header: { task: string }; header_error?: string } };
    assert.equal(validResult.delivery.header.task, 'delivery-valid');
    assert.equal(validResult.delivery.header_error, undefined);

    const mismatch = dispatchJson('delivery-mismatch');
    assert.match(String(mismatch.delivery_header), /task mismatch/);
    const mismatchResult = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-mismatch', 'result.json'), 'utf8'),
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

    const runDir = join(dir, '.router', 'tasks', 'contract-conflict');
    const result = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(result.exit_class, 'contract_conflict');
    assert.equal(result.conflict, true);
    assert.equal('verifier' in result, false);
    assert.equal('diff_sha' in result, false);
    assert.equal(existsSync(join(runDir, 'diff.patch')), false);
    assert.match(readFileSync(join(runDir, 'DELIVERY.md'), 'utf8'), /^\s*CONTRACT_CONFLICT:/);
    assert.equal(fx.git(dir, ['rev-parse', 'router/contract-conflict']).trim(), base);
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
    assert.equal(fx.git(dir, ['rev-parse', 'router/contract-conflict']).trim(), base);

    const land = router(dir, ['land', 'contract-conflict']);
    assert.equal(land.code, 1);
    assert.match(land.out, /contract conflict; refusing to land/);
    assert.match(land.out, /plan needs revising/);
    assert.match(land.out, /DELIVERY\.md/);

    router(dir, ['new', 'contract-conflict-line'], env);
    const line = router(dir, ['dispatch', 'contract-conflict-line'], env);
    assert.equal(line.code, 1);
    assert.match(line.out, /^contract-conflict-line: CONTRACT CONFLICT /);
    assert.match(line.out, /nothing verified; the plan needs revising; report: .*DELIVERY\.md/);
    // The report has to say where we are standing, since nothing switches back for us.
    assert.match(line.out, /You are now on branch router\/contract-conflict-line\./);
    // And it has to say what happened to the edit the CONFLICTED run left uncommitted: this
    // dispatch rescued it into a commit before cutting its own branch. Under the old worktree
    // model that edit sat in a directory nobody would look in; here it is in the user's tree,
    // so losing it silently would be a Must NOT violation.
    assert.match(line.out, /Your uncommitted work was committed first as [0-9a-f]{12}/);
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
      readFileSync(join(dir, '.router', 'tasks', 'risk-raised', 'result.json'), 'utf8'),
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
    // Serial dispatch stacks: p2's branch was cut from p1's, and we end up standing on p2.
    // Choosing the merge target is the user's call, so land needs us off it first.
    assert.equal(fx.git(dir, ['branch', '--show-current']).trim(), 'router/p2');
    fx.git(dir, ['checkout', '-q', 'main']);
    const l = router(dir, ['land', 'p1', 'p2']);
    assert.equal(l.code, 0, l.out);
    assert.match(l.out, /^p1 landed /);
    assert.match(l.out, /\np2 landed /);
    assert.match(readFileSync(join(dir, 'src', 'p1.ts'), 'utf8'), /p1/);
    assert.match(readFileSync(join(dir, 'src', 'p2.ts'), 'utf8'), /p2/);
    assert.equal(fx.git(dir, ['log', '-2', '--pretty=%s']).trim(), "Merge branch 'router/p2'\nMerge branch 'router/p1'");
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

// Fault-injection case 8h. This was a CONFIRMED reproduction before the guard existed, not a
// hypothetical: an executor given a task that changes `router new` ran `router new --id smoke`
// to try its own work, and under the branch model its cwd is the repo root, so it wrote the
// real `.router/tasks/smoke/`. `.router/.gitignore` is `*`, so no gate would ever have seen it.
test('an executor cannot touch real router state (8h)', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  try {
    // The orchestrator scaffolds real state, exactly as a live run would have.
    assert.equal(router(dir, ['new', 'real-task', '--title', 'Real']).code, 0);
    assert.ok(existsSync(join(dir, '.router/tasks/real-task/task.yaml')));

    const sandboxed = { ROUTER_EXECUTOR_SANDBOX: '1' };
    const smoke = router(dir, ['new', 'smoke', '--title', 'Smoke'], sandboxed);
    assert.notEqual(smoke.code, 0);
    assert.match(smoke.out, /refusing to WRITE router state from inside an executor/);
    assert.match(smoke.out, /ROUTER_EXECUTOR_SANDBOX/);
    assert.ok(!existsSync(join(dir, '.router/tasks/smoke')), 'the executor wrote real task state');

    // --router-dir must not be a way around it, and neither must the symbol index, which
    // writes .router/symbols.
    for (const argv of [
      ['new', 'smoke2', '--router-dir', join(dir, '.router')],
      ['symbol', 'index', 'src'],
      ['dispatch', 'real-task'],
    ]) {
      const r = router(dir, argv, sandboxed);
      assert.notEqual(r.code, 0, `${argv.join(' ')} was allowed`);
      assert.match(r.out, /refusing to WRITE router state from inside an executor/);
    }

    // Review finding 9b: the refusal used to cover every verb, including ones that change
    // nothing. Blocking `router list` told an executor "you may not look at the run you are part
    // of" for no safety gain, while the writes it was meant to stop went through a plain file API
    // anyway (see the state-tampering detection).
    for (const argv of [['list'], ['result', 'real-task'], ['models'], ['doctor']]) {
      const r = router(dir, argv, sandboxed);
      // Not "exit 0" -- `result` on a task that was never dispatched legitimately reports that.
      // The assertion is that the SANDBOX is not what stopped it.
      assert.doesNotMatch(r.out, /refusing to/, `${argv.join(' ')} was refused: ${r.out}`);
    }
    assert.equal(router(dir, ['list'], sandboxed).code, 0);
    assert.match(router(dir, ['list'], sandboxed).out, /real-task/);
    assert.ok(!existsSync(join(dir, '.router/tasks/smoke2')));
    assert.ok(!existsSync(join(dir, '.router/symbols')));

    // And the orchestrator itself is unaffected: same verb, no flag, real state still readable.
    const asOrchestrator = router(dir, ['list', '--json']);
    assert.equal(asOrchestrator.code, 0, asOrchestrator.out);
    assert.match(asOrchestrator.out, /real-task/);
  } finally {
    fx.cleanup(dir);
  }
});

// P7 end to end: the design claimed the queue gate's machinery had been absorbed into dispatch,
// while dispatch in fact ran nothing but `task.verify` -- so gate.yaml's `reset` and
// `clean_triggers` were documented and unreachable. This asserts they actually run, by having
// each of them leave a file behind.
test('dispatch runs gate.yaml reset and picks the clean gate when a trigger is touched', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.gitignore', '.router/\nevidence-*\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  const marker = (name: string): string[] =>
    [NODE, '-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, `evidence-${name}`))}, '1')`];
  try {
    router(dir, ['new', 'gated'], env);
    writeFileSync(
      join(dir, '.router', 'gate.yaml'),
      'mode: worktree\n' +
        `reset:\n  - ${JSON.stringify(marker('reset'))}\n` +
        `gate:\n  - ${JSON.stringify(marker('incremental'))}\n` +
        `clean_gate:\n  - ${JSON.stringify(marker('clean'))}\n` +
        'clean_triggers: ["src/*.ts"]\n',
    );
    const d = router(dir, ['dispatch', 'gated', '--json'], env);
    assert.equal(d.code, 0, d.out);
    assert.equal(JSON.parse(d.out).verifier, 'PASSED');

    // Reset ran, and the trigger sent us to the full gate rather than the incremental one.
    assert.ok(existsSync(join(dir, 'evidence-reset')), 'gate.yaml reset never ran');
    assert.ok(existsSync(join(dir, 'evidence-clean')), 'clean_triggers did not select the clean gate');
    assert.ok(!existsSync(join(dir, 'evidence-incremental')), 'the incremental gate ran despite a trigger');

    // ...and the run record names which one it was, so the evidence is not just a side effect.
    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'gated', 'result.json'), 'utf8'),
    ) as { verifier: { checks: { id: string; ok: boolean }[] } };
    const ids = result.verifier.checks.map((check) => check.id);
    assert.ok(ids.includes('reset'), ids.join(','));
    assert.ok(ids.includes('gate:clean'), ids.join(','));
    assert.ok(!ids.includes('verify'), `task.verify ran as well: ${ids.join(',')}`);
  } finally {
    fx.cleanup(dir);
  }
});

// A stored PASSED used to authorize the task BRANCH, not a commit. So anything appended to that
// branch after the verdict -- a resume, or the user by hand -- was merged on the strength of a
// verdict that had never seen it. Two records are checked here, because the fallback for runs
// stored before `verified_head` existed is a different code path and it is the one that decides
// whether upgrading silently trusts exactly the records this finding was about.
test('land refuses a branch that has moved past the commit its verdict judged', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  const resultPath = join(dir, '.router', 'tasks', 'demo', 'result.json');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(JSON.parse(router(dir, ['dispatch', 'demo', '--json'], env).out).verifier, 'PASSED');
    const passed = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    assert.match(String(passed.verified_head), /^[0-9a-f]{40}$/);

    // Somebody adds a commit the verifier never saw.
    fx.write(dir, 'src/a.ts', 'export const x = 99; // never verified\n');
    fx.addCommit(dir, 'unreviewed');
    fx.git(dir, ['checkout', '-q', 'main']);

    const l = router(dir, ['land', 'demo']);
    assert.notEqual(l.code, 0, `land merged an unverified commit: ${l.out}`);
    assert.match(l.out, /was verified|unverified/i, l.out);
    assert.doesNotMatch(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /never verified/);

    // The same record without `verified_head` -- i.e. one written by the build that had the bug.
    // It falls back to re-deriving the diff, and must reach the same answer.
    delete passed.verified_head;
    writeFileSync(resultPath, JSON.stringify(passed));
    const legacy = router(dir, ['land', 'demo']);
    assert.notEqual(legacy.code, 0, `a pre-upgrade record landed unverified work: ${legacy.out}`);
    assert.match(legacy.out, /no longer matches the diff that was verified/, legacy.out);

    // ...and an untouched branch still lands, so the guard is not simply refusing everything.
    fx.git(dir, ['branch', '-f', 'router/demo', 'router/demo~1']);
    const ok = router(dir, ['land', 'demo']);
    assert.equal(ok.code, 0, ok.out);
    assert.match(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), /fake codex/);
  } finally {
    fx.cleanup(dir);
  }
});

// The new head-pinning check runs before the merge, so it is also the first thing to meet a
// branch that is not there any more -- and `git rev-parse` on a missing ref throws a raw,
// locale-dependent GitError with noise on stderr. Landing twice is the ordinary way to get here.
test('landing an already-landed task says so instead of failing in git', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(JSON.parse(router(dir, ['dispatch', 'demo', '--json'], env).out).verifier, 'PASSED');
    fx.git(dir, ['checkout', '-q', 'main']);
    assert.equal(router(dir, ['land', 'demo']).code, 0);

    const again = router(dir, ['land', 'demo']);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /no longer exists/, again.out);
    assert.match(again.out, /already landed as [0-9a-f]{12}/, again.out);
  } finally {
    fx.cleanup(dir);
  }
});

// The first head-pin fix checked the tip and then merged the branch NAME, letting git resolve it
// a second time. The reviewer moved the ref in between and landed an unverified commit:
// `{"landStatus":0,"unverifiedFileLanded":true}`. Reproduced here with a git wrapper that moves
// the branch on the merge call itself, which is the same window a concurrent `update-ref` gets.
test('land merges the commit it verified, not whatever the branch means by then', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(JSON.parse(router(dir, ['dispatch', 'demo', '--json'], env).out).verifier, 'PASSED');
    const verified = fx.git(dir, ['rev-parse', 'router/demo']).trim();

    // An unverified commit parked off to the side, ready to be swapped in.
    fx.git(dir, ['checkout', '-q', '-b', 'evil', 'router/demo']);
    fx.write(dir, 'src/a.ts', 'export const x = 666; // not verified\n');
    fx.addCommit(dir, 'evil');
    const evil = fx.git(dir, ['rev-parse', 'evil']).trim();
    fx.git(dir, ['checkout', '-q', 'main']);

    // A `git` on PATH that moves router/demo to the evil commit the moment land runs `merge`.
    const shim = join(dir, 'shimbin');
    execFileSync('mkdir', ['-p', shim]);
    writeFileSync(
      join(shim, 'git'),
      '#!/bin/sh\n' +
        'real=/usr/bin/git\n' +
        'for a in "$@"; do\n' +
        '  if [ "$a" = "merge" ]; then\n' +
        `    "$real" update-ref refs/heads/router/demo ${evil} >/dev/null 2>&1\n` +
        '    break\n' +
        '  fi\n' +
        'done\n' +
        'exec "$real" "$@"\n',
    );
    chmodSync(join(shim, 'git'), 0o755);

    const l = router(dir, ['land', 'demo'], { ...env, PATH: `${shim}:${process.env.PATH}` });
    // Either outcome is acceptable; landing the evil commit is not.
    assert.doesNotMatch(
      readFileSync(join(dir, 'src', 'a.ts'), 'utf8'),
      /not verified/,
      `land merged a commit that was swapped in after the check: ${l.out}`,
    );
    // If it merged at all, it merged the SHA it verified.
    if (l.code === 0) {
      assert.match(fx.git(dir, ['log', '--format=%H', 'main']), new RegExp(verified));
    }
  } finally {
    fx.cleanup(dir);
  }
});
