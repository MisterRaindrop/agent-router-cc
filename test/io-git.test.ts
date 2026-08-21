// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import {
  applyCheck,
  assertTaskIdentity,
  branchExists,
  collectDiff,
  commitAll,
  createBranchStrict,
  currentBranch,
  isAncestor,
  listDirFileModes,
  rawDiff,
  rescueCommit,
  resetHardTracked,
  resolveCommit,
  showFileAtRev,
  submoduleDirty,
  TaskIdentityError,
  uncommittedSourceFiles,
  worktreeAdd,
  worktreeAddDetached,
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

test('collectDiff reports the new file mode; listDirFileModes reads a directory convention', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'sh/one.sh', '#!/bin/sh\ntrue\n');
    fx.write(dir, 'sh/two.sh', '#!/bin/sh\ntrue\n');
    chmodSync(join(dir, 'sh/one.sh'), 0o755);
    chmodSync(join(dir, 'sh/two.sh'), 0o755);
    const base = fx.addCommit(dir, 'base');

    fx.write(dir, 'sh/three.sh', '#!/bin/sh\ntrue\n'); // added non-executable
    fx.write(dir, 'sh/four.sh', '#!/bin/sh\ntrue\n');
    chmodSync(join(dir, 'sh/four.sh'), 0o755);
    const head = fx.addCommit(dir, 'add scripts');

    const m = byPath(collectDiff(dir, base, head));
    assert.equal(m.get('sh/three.sh')?.newMode, '100644');
    assert.equal(m.get('sh/four.sh')?.newMode, '100755');

    const modes = listDirFileModes(dir, base, 'sh');
    assert.deepEqual(
      modes.sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'one.sh', mode: '100755' },
        { name: 'two.sh', mode: '100755' },
      ],
    );
    assert.deepEqual(listDirFileModes(dir, base, 'does/not/exist'), []); // no evidence, no throw
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

    // A throwaway detached checkout at base -- the same scratch space the verifier uses for
    // exactly this question. It needs no branch, so it does not go through the deprecated
    // per-task worktree helper.
    const wt = join(dir, '..', `wt-${Date.now()}`);
    worktreeAddDetached(dir, wt, base);
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

// Was 'worktreeAdd creates a branch'. Per-task worktrees are deprecated and refused by
// default -- the assertion is now that the refusal happens and names its escape hatch, because
// a deprecated path that still runs silently leaves two execution models with different
// behaviour and no way to tell which produced a result.
test('worktreeAdd refuses by default and names its escape hatch', () => {
  const dir = fx.initRepo();
  const previous = process.env.ROUTER_ALLOW_WORKTREE_MODE;
  delete process.env.ROUTER_ALLOW_WORKTREE_MODE;
  try {
    fx.write(dir, 'a.txt', 'x\n');
    const base = fx.addCommit(dir, 'base');
    const wt = join(dir, '..', `wt2-${Date.now()}`);
    assert.throws(() => worktreeAdd(dir, wt, 'router/t', base), /deprecated/);
    assert.throws(() => worktreeAdd(dir, wt, 'router/t', base), /ROUTER_ALLOW_WORKTREE_MODE=1/);
    assert.equal(existsSync(wt), false);
    assert.equal(branchExists(dir, 'router/t'), false);

    // And the hatch actually works, so "kept for one version" is a thing you can do rather
    // than a comment.
    process.env.ROUTER_ALLOW_WORKTREE_MODE = '1';
    worktreeAdd(dir, wt, 'router/t', base);
    assert.ok(existsSync(join(wt, 'a.txt')));
    assert.equal(branchExists(dir, 'router/t'), true);
    worktreeRemove(dir, wt);
    assert.equal(existsSync(wt), false);
  } finally {
    if (previous === undefined) delete process.env.ROUTER_ALLOW_WORKTREE_MODE;
    else process.env.ROUTER_ALLOW_WORKTREE_MODE = previous;
    fx.cleanup(dir);
  }
});

// --- Branch-mode primitives (P2) ------------------------------------------------
//
// These guard the failure-injection cases the design review demanded (DESIGN §6.1, 8d and
// 8g). Both describe destruction that the old worktree model made impossible and the branch
// model makes reachable, so each gets a test that actually destroys something and then checks
// what survived.

test('createBranchStrict refuses a name that already exists (8d)', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'hi\n');
    fx.addCommit(dir, 'base');
    createBranchStrict(dir, 'router/task-1');
    assert.equal(currentBranch(dir), 'router/task-1');

    // A commit that only exists on the stale branch. Silently reusing the branch would put the
    // retry path's reset on top of it.
    fx.write(dir, 'stale.txt', 'work from a previous task\n');
    const stale = fx.addCommit(dir, 'stale work');
    fx.git(dir, ['checkout', '-q', 'main']);

    assert.throws(() => createBranchStrict(dir, 'router/task-1'), TaskIdentityError);
    // Refused, and the stale branch is untouched -- still pointing at its own commit.
    assert.equal(fx.git(dir, ['rev-parse', 'router/task-1']).trim(), stale);
    assert.equal(currentBranch(dir), 'main');
  } finally {
    fx.cleanup(dir);
  }
});

test('rescueCommit captures tracked edits and untracked files, and survives a later reset (8g)', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'tracked.txt', 'original\n');
    fx.write(dir, '.gitignore', 'build/\n');
    const base = fx.addCommit(dir, 'base');

    // Exactly the mix the flow has to keep: an edit to a tracked file, a brand-new untracked
    // file, and ignored build output that must NOT be dragged in.
    fx.write(dir, 'tracked.txt', 'edited by the user\n');
    fx.write(dir, 'new-untracked.txt', 'written during the run\n');
    fx.write(dir, 'build/artifact.o', 'ignored\n');

    const rescue = rescueCommit(dir, 'router: rescue uncommitted work');
    assert.ok(rescue !== null);
    assert.match(rescue.sha, /^[0-9a-f]{40}$/);
    assert.deepEqual(rescue.files.sort(), ['new-untracked.txt', 'tracked.txt']);
    assert.deepEqual(uncommittedSourceFiles(dir), []);

    assert.ok(isAncestor(dir, base, 'HEAD'));
    // And the ignored artifact never entered history.
    assert.equal(fx.git(dir, ['ls-files', 'build/']).trim(), '');

    // Now the case 8g actually describes: the run is under way on the task branch, the user
    // creates a file while it runs, and then a quota failure triggers a retry to base_sha.
    createBranchStrict(dir, 'router/task-1');
    const baseSha = resolveCommit(dir, 'HEAD');
    fx.write(dir, 'executor-work.txt', 'half-finished\n');
    fx.addCommit(dir, 'unit a');
    fx.write(dir, 'user-typed-this.txt', 'created by the human mid-run\n');

    // The required order: rescue first, THEN reset. Rescuing is what makes the reset safe --
    // the file is tracked by the time anything destructive runs.
    const second = rescueCommit(dir, 'router: rescue before retry');
    assert.ok(second !== null);
    assert.deepEqual(second.files, ['user-typed-this.txt']);
    resetHardTracked(dir, baseSha);

    // The executor's own half-finished commit is gone, which is the point of the retry...
    assert.equal(resolveCommit(dir, 'HEAD'), baseSha);
    assert.ok(!existsSync(join(dir, 'executor-work.txt')));
    // ...and the human's file is still recoverable from the rescue commit. Without the rescue
    // it would be gone twice over: `resetHard` also runs `git clean -fd`.
    assert.equal(
      fx.git(dir, ['show', `${second.sha}:user-typed-this.txt`]),
      'created by the human mid-run\n',
    );
  } finally {
    fx.cleanup(dir);
  }
});

test('rescueCommit on a clean tree makes no commit at all', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'hi\n');
    const base = fx.addCommit(dir, 'base');
    assert.equal(rescueCommit(dir, 'router: rescue'), null);
    assert.equal(resolveCommit(dir, 'HEAD'), base);
  } finally {
    fx.cleanup(dir);
  }
});

test('rescueCommit ignores files the repo ignores, even when nothing else is dirty', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, '.gitignore', 'build/\n');
    const base = fx.addCommit(dir, 'base');
    fx.write(dir, 'build/artifact.o', 'ignored\n');
    assert.equal(rescueCommit(dir, 'router: rescue'), null);
    assert.equal(resolveCommit(dir, 'HEAD'), base);
  } finally {
    fx.cleanup(dir);
  }
});

test('assertTaskIdentity rejects the wrong branch, a detached HEAD, and a rewritten base (8e)', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'a.txt', 'hi\n');
    fx.addCommit(dir, 'base');
    createBranchStrict(dir, 'router/task-1');
    const baseSha = resolveCommit(dir, 'HEAD');
    fx.write(dir, 'b.txt', 'work\n');
    fx.addCommit(dir, 'unit a');

    // On the task branch with base_sha still reachable: fine.
    assertTaskIdentity(dir, { branch: 'router/task-1', baseSha });

    // The user wandered off mid-run. This is the case that used to be impossible.
    fx.git(dir, ['checkout', '-q', 'main']);
    assert.throws(
      () => assertTaskIdentity(dir, { branch: 'router/task-1', baseSha }),
      (err: unknown) => err instanceof TaskIdentityError && /on branch main/.test((err as Error).message),
    );

    // Detached HEAD is not "some branch" -- it must not pass either.
    fx.git(dir, ['checkout', '-q', '--detach', 'HEAD']);
    assert.throws(
      () => assertTaskIdentity(dir, { branch: 'router/task-1', baseSha }),
      (err: unknown) => err instanceof TaskIdentityError && /detached/.test((err as Error).message),
    );

    // Same branch name, but its history no longer contains the base the task was cut from.
    fx.git(dir, ['checkout', '-q', 'router/task-1']);
    fx.git(dir, ['checkout', '-q', '--orphan', 'router/task-2']);
    fx.write(dir, 'c.txt', 'unrelated\n');
    fx.addCommit(dir, 'orphan root');
    assert.throws(
      () => assertTaskIdentity(dir, { branch: 'router/task-2', baseSha }),
      (err: unknown) => err instanceof TaskIdentityError && /not an ancestor/.test((err as Error).message),
    );
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
    fx.write(dir, 'left-behind.txt', 'the file the executor forgot\n');
    const lines = uncommittedSourceFiles(dir);
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => l.includes('tracked.txt')));
    assert.ok(lines.some((l) => l.includes('left-behind.txt')));
  } finally {
    fx.cleanup(dir);
  }
});

test('submoduleDirty separates submodule content dirt from our own changes', () => {
  const inner = fx.initRepo();
  const outer = fx.initRepo();
  try {
    fx.write(inner, 'lib.txt', 'v1\n');
    fx.addCommit(inner, 'inner base');
    fx.write(outer, 'a.txt', 'v1\n');
    fx.addCommit(outer, 'outer base');
    fx.git(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/lib']);
    fx.addCommit(outer, 'add submodule');

    assert.deepEqual(submoduleDirty(outer), []);

    // Build residue inside the submodule: not our work, not rescuable, not a reason to refuse.
    fx.write(outer, 'vendor/lib/lib.txt', 'touched by a build\n');
    const dirt = submoduleDirty(outer);
    assert.equal(dirt.length, 1);
    assert.ok(dirt[0]!.includes('vendor/lib'));
    // ...and it stays out of the closing invariant, which would otherwise never be satisfiable
    // on a warm C/C++ checkout.
    assert.deepEqual(uncommittedSourceFiles(outer), []);

    // Our own edit alongside it is still reported.
    fx.write(outer, 'a.txt', 'v2\n');
    assert.equal(uncommittedSourceFiles(outer).length, 1);
    assert.ok(uncommittedSourceFiles(outer)[0]!.includes('a.txt'));
  } finally {
    fx.cleanup(inner);
    fx.cleanup(outer);
  }
});
