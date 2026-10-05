// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { commitsSince, currentBranch, resolveCommit, uncommittedSourceFiles } from '../src/io/git.ts';

test('resolveCommit returns a full 40-hex sha', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'hi\n');
    const sha = fx.addCommit(dir, 'base');
    assert.match(resolveCommit(dir, 'HEAD'), /^[0-9a-f]{40}$/);
    assert.equal(resolveCommit(dir, 'HEAD'), sha);
  } finally {
    fx.cleanup(dir);
  }
});

test('currentBranch names the checked-out branch and is null on a detached HEAD', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'hi\n');
    const sha = fx.addCommit(dir, 'base');
    assert.equal(typeof currentBranch(dir), 'string');
    fx.git(dir, ['checkout', '-q', '--detach', sha]);
    assert.equal(currentBranch(dir), null);
  } finally {
    fx.cleanup(dir);
  }
});

test('commitsSince lists the commits after a base, newest first', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'v1\n');
    const base = fx.addCommit(dir, 'base');
    assert.deepEqual(commitsSince(dir, base), []);
    fx.write(dir, 'a.txt', 'v2\n');
    fx.addCommit(dir, 'unit one');
    fx.write(dir, 'b.txt', 'b\n');
    fx.addCommit(dir, 'unit two');
    const log = commitsSince(dir, base);
    assert.equal(log.length, 2);
    assert.match(log[0]!, /unit two$/);
    assert.match(log[1]!, /unit one$/);
  } finally {
    fx.cleanup(dir);
  }
});

test('uncommittedSourceFiles reports tracked edits and untracked files but not ignored ones', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'tracked.txt', 'v1\n');
    fx.write(dir, '.gitignore', 'build/\n');
    fx.addCommit(dir, 'base');
    assert.deepEqual(uncommittedSourceFiles(dir), []);

    fx.write(dir, 'build/out.o', 'ignored\n');
    assert.deepEqual(uncommittedSourceFiles(dir), []);

    fx.write(dir, 'tracked.txt', 'v2\n');
    fx.write(dir, 'left-behind.txt', 'the file the writer forgot\n');
    const lines = uncommittedSourceFiles(dir);
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.includes('tracked.txt')));
    assert.ok(lines.some((l) => l.includes('left-behind.txt')));
  } finally {
    fx.cleanup(dir);
  }
});

// `router write` refuses on a dirty tree, so "could not check" must never read as "clean".
test('uncommittedSourceFiles throws rather than reporting a broken repo as clean', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'v1\n');
    fx.addCommit(dir, 'base');
    fx.write(dir, 'a.txt', 'v2\n');
    assert.equal(uncommittedSourceFiles(dir).length, 1);

    // A corrupt index: `git status` exits non-zero with a fatal message.
    writeFileSync(join(dir, '.git', 'index'), 'this is not an index');
    assert.throws(() => uncommittedSourceFiles(dir), /git status/);
  } finally {
    fx.cleanup(dir);
  }
});
