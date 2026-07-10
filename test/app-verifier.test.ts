// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { worktreeAdd } from '../src/io/git.ts';
import { hashContract } from '../src/core/contractHash.ts';
import { verify, type VerifyRequest } from '../src/app/verifier.ts';
import type { Policy, TaskYaml } from '../src/domain/types.ts';

const policy = (over: Partial<Policy> = {}): Policy => ({
  schema_version: 1,
  scope: { max_changed_lines: 400, forbidden_globs: [], test_globs: ['tests/**'] },
  verification: {
    build: [['node', '-e', 'process.exit(0)']],
    test: [['node', '-e', 'process.exit(0)']],
  },
  ...over,
});

const task = (over: Partial<TaskYaml> = {}): TaskYaml => ({
  schema_version: 1,
  id: 't',
  title: 'T',
  base_sha: null,
  max_wall_minutes: 30,
  allowed_globs: ['src/**'],
  build_ref: 'build',
  test_ref: 'test',
  ...over,
});

const TASK_TXT = 'schema_version: 1\nid: t\n';
const CONTRACT_TXT = '# Contract\nDo the thing.\n';
const FROZEN = hashContract(TASK_TXT, CONTRACT_TXT);

let runN = 0;
function baseRepo(): { dir: string; base: string } {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, 'tests/t.test.ts', 'ok\n');
  fx.write(dir, '.router/policy.yaml', 'schema_version: 1\n');
  const base = fx.addCommit(dir, 'base');
  return { dir, base };
}
function makeRun(dir: string, base: string, change: (wt: string) => void): string {
  runN += 1;
  const wt = join(dir, '..', `wt-verify-${runN}-${base.slice(0, 6)}`);
  worktreeAdd(dir, wt, `router/t/run-${runN}`, base);
  change(wt);
  return wt;
}
function req(dir: string, base: string, wt: string, over: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    repoRoot: dir,
    worktreeDir: wt,
    baseSha: base,
    head: 'HEAD',
    policy: policy(),
    task: task(),
    frozenContractHash: FROZEN,
    taskYamlText: TASK_TXT,
    contractMdText: CONTRACT_TXT,
    env: process.env,
    ...over,
  };
}

test('all checks pass for an in-scope, building, passing change', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'export const x = 2;\n');
      fx.addCommit(w, 'edit');
    });
    const report = verify(req(dir, base, wt));
    assert.equal(report.result, 'PASSED', JSON.stringify(report.checks));
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'secret_scan', 'build', 'test', 'contract_hash']);
    assert.ok(report.checks.every((c) => c.ok));
  } finally {
    fx.cleanup(dir);
  }
});

test('secret scan fails verification when a private key is added (after scope, before build)', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'const k = "-----BEGIN RSA PRIVATE KEY-----";\n');
      fx.addCommit(w, 'leak');
    });
    const report = verify(req(dir, base, wt));
    assert.equal(report.result, 'FAILED');
    // fail-fast: scope passed, secret_scan caught it before build ran
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'secret_scan']);
    assert.equal(report.checks.at(-1)?.ok, false);
    assert.match(report.checks.at(-1)?.detail ?? '', /private_key_header/);
  } finally {
    fx.cleanup(dir);
  }
});

test('secret scan can be disabled via policy.secret_scan.enabled=false', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'const k = "-----BEGIN RSA PRIVATE KEY-----";\n');
      fx.addCommit(w, 'leak');
    });
    const report = verify(req(dir, base, wt, { policy: policy({ secret_scan: { enabled: false } }) }));
    assert.equal(report.result, 'PASSED', JSON.stringify(report.checks));
    // no secret_scan check present when disabled
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'build', 'test', 'contract_hash']);
  } finally {
    fx.cleanup(dir);
  }
});

test('check 1 fails on an empty diff (no commit beyond base)', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, () => {}); // no change
    const report = verify(req(dir, base, wt));
    assert.equal(report.result, 'FAILED');
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.id, 'diff_applies');
  } finally {
    fx.cleanup(dir);
  }
});

test('check 2 fails on an out-of-scope change (fail-fast before build)', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'docs/secret.md', 'oops\n');
      fx.addCommit(w, 'out of scope');
    });
    const report = verify(req(dir, base, wt));
    assert.equal(report.result, 'FAILED');
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope']);
    assert.equal(report.checks[1]?.ok, false);
  } finally {
    fx.cleanup(dir);
  }
});

test('check 3 fails when the build command exits nonzero', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'export const x = 3;\n');
      fx.addCommit(w, 'edit');
    });
    const report = verify(
      req(dir, base, wt, { policy: policy({ verification: { build: [['node', '-e', 'process.exit(1)']], test: [['node', '-e', 'process.exit(0)']] } }) }),
    );
    assert.equal(report.result, 'FAILED');
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'secret_scan', 'build']);
    assert.equal(report.checks[3]?.rc, 1);
  } finally {
    fx.cleanup(dir);
  }
});

test('check 4 fails when tests exit nonzero (build passed)', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'export const x = 4;\n');
      fx.addCommit(w, 'edit');
    });
    const report = verify(
      req(dir, base, wt, { policy: policy({ verification: { build: [['node', '-e', 'process.exit(0)']], test: [['node', '-e', 'process.exit(2)']] } }) }),
    );
    assert.equal(report.result, 'FAILED');
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'secret_scan', 'build', 'test']);
    assert.equal(report.checks[4]?.rc, 2);
  } finally {
    fx.cleanup(dir);
  }
});

test('check 5 fails when the frozen contract was modified after validation', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'export const x = 5;\n');
      fx.addCommit(w, 'edit');
    });
    // Same everything, but the on-disk contract text no longer matches FROZEN.
    const report = verify(req(dir, base, wt, { contractMdText: '# Contract\nTAMPERED\n' }));
    assert.equal(report.result, 'FAILED');
    assert.deepEqual(report.checks.map((c) => c.id), ['diff_applies', 'scope', 'secret_scan', 'build', 'test', 'contract_hash']);
    assert.equal(report.checks[5]?.ok, false);
  } finally {
    fx.cleanup(dir);
  }
});

test('command not whitelisted (missing param) fails the build check', () => {
  const { dir, base } = baseRepo();
  try {
    const wt = makeRun(dir, base, (w) => {
      fx.write(w, 'src/a.ts', 'export const x = 6;\n');
      fx.addCommit(w, 'edit');
    });
    const report = verify(
      req(dir, base, wt, {
        policy: policy({ verification: { build: [['make', '-C', '{missing}']], test: [['node', '-e', 'process.exit(0)']] } }),
      }),
    );
    assert.equal(report.result, 'FAILED');
    assert.equal(report.checks.at(-1)?.id, 'build');
    assert.match(report.checks.at(-1)?.detail ?? '', /not whitelisted/);
  } finally {
    fx.cleanup(dir);
  }
});
