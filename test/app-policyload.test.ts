// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { routerPaths } from '../src/io/paths.ts';
import { loadPolicyFromDisk, loadPolicyFromGit, PolicyError } from '../src/app/policyLoad.ts';

const POLICY = `
schema_version: 1
max_concurrent_workers: 1
worker:
  kind: codex
  api_key_env: OPENAI_API_KEY
scope:
  forbidden_globs: ["src/wal/**"]
  test_globs: ["tests/**"]
  max_changed_lines: 400
verification:
  build:
    - ["make", "-C", "{build_dir}"]
  test:
    - ["ctest", "--test-dir", "{build_dir}"]
`;

test('loadPolicyFromGit reads the COMMITTED policy, not the tampered worktree copy', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, '.router/policy.yaml', POLICY);
    const base = fx.addCommit(dir, 'add policy');
    const paths = routerPaths(join(dir, '.router'));

    // Worker tampers with the working-copy policy to weaken the rules.
    const TAMPERED = POLICY.replace('max_changed_lines: 400', 'max_changed_lines: 999999').replace(
      'forbidden_globs: ["src/wal/**"]',
      'forbidden_globs: []',
    );
    fx.write(dir, '.router/policy.yaml', TAMPERED);

    const fromGit = loadPolicyFromGit(paths, base);
    const fromDisk = loadPolicyFromDisk(paths);

    // git object keeps the original rules; disk reflects the tampering.
    assert.equal(fromGit.scope.max_changed_lines, 400);
    assert.deepEqual(fromGit.scope.forbidden_globs, ['src/wal/**']);
    assert.equal(fromDisk.scope.max_changed_lines, 999999);
    assert.deepEqual(fromDisk.scope.forbidden_globs, []);
  } finally {
    fx.cleanup(dir);
  }
});

test('loadPolicyFromGit parses the whitelist templates', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, '.router/policy.yaml', POLICY);
    const base = fx.addCommit(dir, 'p');
    const paths = routerPaths(join(dir, '.router'));
    const p = loadPolicyFromGit(paths, base);
    assert.deepEqual(p.verification.build, [['make', '-C', '{build_dir}']]);
  } finally {
    fx.cleanup(dir);
  }
});

test('missing policy at base_sha throws PolicyError', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'README.md', 'hi\n');
    const base = fx.addCommit(dir, 'no policy');
    const paths = routerPaths(join(dir, '.router'));
    assert.throws(() => loadPolicyFromGit(paths, base), PolicyError);
  } finally {
    fx.cleanup(dir);
  }
});

test('invalid policy at base_sha throws PolicyError', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, '.router/policy.yaml', 'schema_version: 1\n'); // missing scope/verification
    const base = fx.addCommit(dir, 'bad');
    const paths = routerPaths(join(dir, '.router'));
    assert.throws(() => loadPolicyFromGit(paths, base), PolicyError);
  } finally {
    fx.cleanup(dir);
  }
});
