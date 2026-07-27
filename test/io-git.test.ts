// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import {
  applyCheck,
  branchExists,
  collectDiff,
  commitAll,
  rawDiff,
  resolveCommit,
  showFileAtRev,
  worktreeAdd,
  worktreeRemove,
} from '../src/io/git.ts';
import type { DiffEntry } from '../src/domain/types.ts';

function byPath(entries: DiffEntry[]): Map<string, DiffEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}

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

test('commitAll carries its own identity (independent of ambient git config)', () => {
  const dir = fx.initRepo(); // initRepo sets a DIFFERENT local identity
  try {
    fx.write(dir, 'src/a.txt', 'hello\n');
    assert.equal(commitAll(dir, 'router: test run'), true);
    // The -c override must win over the repo's configured identity, so router's
    // bookkeeping commit works even in a repo/container with no identity at all.
    assert.equal(fx.git(dir, ['log', '-1', '--format=%an <%ae>']).trim(), 'router <router@localhost>');
    assert.equal(commitAll(dir, 'noop'), false); // clean tree => no commit
  } finally {
    fx.cleanup(dir);
  }
});

test('collectDiff parses A/M/D/R + binary + spaced/unicode paths', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'l1\nl2\nl3\n');
    fx.write(dir, 'keep.txt', 'keep\n');
    fx.write(dir, 'sub/old.txt', 'x\n');
    fx.writeBinary(dir, 'bin.dat', new Uint8Array([0, 1, 2, 0, 255, 7]));
    const base = fx.addCommit(dir, 'base');

    fx.write(dir, 'a.txt', 'l1\nCHANGED\nl3\nl4\n'); // M
    fx.rm(dir, 'keep.txt'); // D
    fx.mv(dir, 'sub/old.txt', 'sub/new name.txt'); // R (spaced path)
    fx.write(dir, 'ünïcode.txt', 'hi\n'); // A (unicode)
    fx.writeBinary(dir, 'bin.dat', new Uint8Array([0, 1, 2, 3, 0, 9, 9, 9])); // M binary
    const head = fx.addCommit(dir, 'changes');

    const m = byPath(collectDiff(dir, base, head));

    assert.equal(m.get('a.txt')?.status, 'M');
    assert.equal(m.get('a.txt')?.added, 2);
    assert.equal(m.get('a.txt')?.deleted, 1);

    assert.equal(m.get('keep.txt')?.status, 'D');

    const rn = m.get('sub/new name.txt');
    assert.equal(rn?.status, 'R');
    assert.equal(rn?.oldPath, 'sub/old.txt');

    assert.equal(m.get('ünïcode.txt')?.status, 'A');

    assert.equal(m.get('bin.dat')?.binary, true);
    assert.equal(m.get('bin.dat')?.added, 0);
    assert.equal(m.get('bin.dat')?.deleted, 0);
  } finally {
    fx.cleanup(dir);
  }
});

test('collectDiff against the working tree (no head)', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'one\n');
    const base = fx.addCommit(dir, 'base');
    fx.write(dir, 'a.txt', 'one\ntwo\n');
    fx.git(dir, ['add', '-A']);
    const m = byPath(collectDiff(dir, base));
    assert.equal(m.get('a.txt')?.added, 1);
  } finally {
    fx.cleanup(dir);
  }
});

test('showFileAtRev reads committed content; null when absent', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'cfg.yaml', 'k: v\n');
    const base = fx.addCommit(dir, 'base');
    // change the working copy; showFileAtRev must read the COMMITTED version
    fx.write(dir, 'cfg.yaml', 'k: TAMPERED\n');
    assert.equal(showFileAtRev(dir, base, 'cfg.yaml'), 'k: v\n');
    assert.equal(showFileAtRev(dir, base, 'does/not/exist'), null);
  } finally {
    fx.cleanup(dir);
  }
});

test('rawDiff + applyCheck: clean patch applies, garbage does not', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'one\n');
    const base = fx.addCommit(dir, 'base');
    fx.write(dir, 'a.txt', 'one\ntwo\n');
    const head = fx.addCommit(dir, 'change');
    const patch = rawDiff(dir, base, head);
    assert.ok(patch.includes('two'));

    // In a fresh worktree checked out at base, the patch applies cleanly.
    const wt = join(dir, '..', `wt-${Date.now()}`);
    worktreeAdd(dir, wt, 'router/test/run-001', base);
    try {
      assert.equal(applyCheck(wt, patch), true);
      assert.equal(applyCheck(wt, 'not a patch at all\n@@ bogus @@\n'), false);
    } finally {
      worktreeRemove(dir, wt);
      assert.equal(existsSync(wt), false);
    }
  } finally {
    fx.cleanup(dir);
  }
});

test('collectDiff counts lines for a path containing a TAB (numstat parse, #8)', () => {
  const dir = fx.initRepo();
  try {
    const tabName = 'weird\tname.txt';
    fx.write(dir, tabName, 'a\nb\n');
    const base = fx.addCommit(dir, 'base');
    fx.write(dir, tabName, 'a\nB\nc\nd\n');
    const head = fx.addCommit(dir, 'edit');
    const m = byPath(collectDiff(dir, base, head));
    const e = m.get(tabName);
    assert.ok(e, 'tab-named file must be found (path not truncated)');
    assert.ok((e!.added + e!.deleted) > 0, 'line churn must be counted, not silently 0');
  } finally {
    fx.cleanup(dir);
  }
});

test('mergeAbort restores the working tree after a conflict (#11)', async () => {
  const { mergeNoFF, mergeAbort } = await import('../src/io/git.ts');
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'f.txt', 'base\n');
    fx.addCommit(dir, 'base');
    fx.git(dir, ['checkout', '-q', '-b', 'feature']);
    fx.write(dir, 'f.txt', 'feature\n');
    fx.addCommit(dir, 'feat');
    fx.git(dir, ['checkout', '-q', 'main']);
    fx.write(dir, 'f.txt', 'mainline\n');
    fx.addCommit(dir, 'main-edit');
    assert.throws(() => mergeNoFF(dir, 'feature'));
    mergeAbort(dir);
    // clean tree, no MERGE_HEAD, HEAD content intact
    assert.equal(fx.git(dir, ['status', '--porcelain']).trim(), '');
  } finally {
    fx.cleanup(dir);
  }
});

test('worktreeAdd creates a branch; worktreeRemove cleans up', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'x\n');
    const base = fx.addCommit(dir, 'base');
    const wt = join(dir, '..', `wt2-${Date.now()}`);
    worktreeAdd(dir, wt, 'router/t/run-001', base);
    assert.ok(existsSync(join(wt, 'a.txt')));
    assert.equal(branchExists(dir, 'router/t/run-001'), true);
    worktreeRemove(dir, wt);
    assert.equal(existsSync(wt), false);
  } finally {
    fx.cleanup(dir);
  }
});
