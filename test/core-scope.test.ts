// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAny, matchGlob } from '../src/core/glob.ts';
import { evaluateScope } from '../src/core/scope.ts';
import * as fx from '../testkit/gitRepo.ts';
import { collectDiff } from '../src/io/git.ts';
import type { DiffEntry, EffectiveScope } from '../src/domain/types.ts';

const de = (over: Partial<DiffEntry> & Pick<DiffEntry, 'status' | 'path'>): DiffEntry => ({
  added: 1,
  deleted: 0,
  binary: false,
  ...over,
});

const scope = (over: Partial<EffectiveScope> = {}): EffectiveScope => ({
  allowed_globs: ['src/**', 'tests/**'],
  forbidden_globs: ['src/wal/**', '**/*.lock'],
  test_globs: ['tests/**'],
  max_changed_lines: 100,
  ...over,
});

// -- glob --
test('glob: * stays within a segment, ** spans segments', () => {
  assert.equal(matchGlob('src/a.ts', 'src/*'), true);
  assert.equal(matchGlob('src/a/b.ts', 'src/*'), false);
  assert.equal(matchGlob('src/a/b.ts', 'src/**'), true);
  assert.equal(matchGlob('src/a.ts', 'src/**'), true);
  assert.equal(matchGlob('a.lock', '**/*.lock'), true);
  assert.equal(matchGlob('x/y/a.lock', '**/*.lock'), true);
  assert.equal(matchGlob('tests/foo_test.py', 'tests/**'), true);
  assert.equal(matchGlob('srcfoo/a.ts', 'src/**'), false);
});

test('glob: dotfiles and ? and specials', () => {
  assert.equal(matchGlob('.router/x', '.router/**'), true);
  assert.equal(matchGlob('a.b', 'a?b'), true);
  assert.equal(matchGlob('config.yaml', 'config.yaml'), true);
  assert.equal(matchAny('src/a.ts', ['nope/**', 'src/**']), true);
});

// -- evaluateScope --
test('empty diff fails', () => {
  const v = evaluateScope([], scope());
  assert.equal(v.ok, false);
  assert.equal(v.violations[0]?.kind, 'empty_diff');
});

test('in-scope change passes and counts lines (binary excluded)', () => {
  const v = evaluateScope(
    [
      de({ status: 'M', path: 'src/a.ts', added: 10, deleted: 5 }),
      de({ status: 'M', path: 'src/logo.png', added: 0, deleted: 0, binary: true }),
    ],
    scope(),
  );
  assert.ok(v.ok, JSON.stringify(v.violations));
  assert.equal(v.changedLines, 15);
});

test('path outside allowed_globs => not_allowed', () => {
  const v = evaluateScope([de({ status: 'M', path: 'docs/readme.md' })], scope());
  assert.equal(v.ok, false);
  assert.equal(v.violations[0]?.kind, 'not_allowed');
});

test('forbidden glob wins even if also allowed', () => {
  const v = evaluateScope([de({ status: 'M', path: 'src/wal/xlog.c' })], scope());
  assert.equal(v.ok, false);
  assert.equal(v.violations[0]?.kind, 'forbidden');
});

test('deleting a test file => test_deletion', () => {
  const v = evaluateScope([de({ status: 'D', path: 'tests/t_scan.py', added: 0, deleted: 20 })], scope());
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === 'test_deletion'));
});

test('rename checks BOTH old and new path', () => {
  // moving a file OUT of scope: new path outside allowed
  const v = evaluateScope(
    [de({ status: 'R', path: 'docs/moved.ts', oldPath: 'src/a.ts' })],
    scope(),
  );
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === 'not_allowed' && x.path === 'docs/moved.ts'));

  // moving a forbidden source
  const v2 = evaluateScope(
    [de({ status: 'R', path: 'src/ok.ts', oldPath: 'src/wal/xlog.c' })],
    scope(),
  );
  assert.equal(v2.ok, false);
  assert.ok(v2.violations.some((x) => x.kind === 'forbidden' && x.path === 'src/wal/xlog.c'));
});

test('renaming a test file OUT of test_globs is caught as test_deletion (#7)', () => {
  const v = evaluateScope(
    [de({ status: 'R', path: 'src/foo_old.ts', oldPath: 'tests/foo.test.ts' })],
    scope({ allowed_globs: ['src/**', 'tests/**'] }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.kind === 'test_deletion'));
});

test('glob: non-boundary ** does not cross / (#12)', () => {
  // trailing ** still spans directories (the common `src/**` case)
  assert.equal(matchGlob('src/a/b.ts', 'src/**'), true);
  // ** wedged mid-segment must NOT cross '/'
  assert.equal(matchGlob('pkg/sub/util.ts', 'pkg**util.ts'), false);
  assert.equal(matchGlob('pkgXutil.ts', 'pkg**util.ts'), true);
});

test('max_changed_lines boundary', () => {
  assert.equal(evaluateScope([de({ status: 'M', path: 'src/a.ts', added: 100, deleted: 0 })], scope()).ok, true);
  const over = evaluateScope([de({ status: 'M', path: 'src/a.ts', added: 100, deleted: 1 })], scope());
  assert.equal(over.ok, false);
  assert.ok(over.violations.some((x) => x.kind === 'max_lines'));
});

test('end-to-end: a real out-of-scope diff from a fixture repo is caught', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'src/a.ts', 'x\n');
    fx.write(dir, 'src/wal/xlog.c', 'safe\n');
    const base = fx.addCommit(dir, 'base');
    fx.write(dir, 'src/wal/xlog.c', 'TOUCHED forbidden\n'); // touches forbidden path
    const head = fx.addCommit(dir, 'bad');
    const v = evaluateScope(collectDiff(dir, base, head), scope());
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => x.kind === 'forbidden'));
  } finally {
    fx.cleanup(dir);
  }
});
