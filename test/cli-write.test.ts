// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { childEnv } from './childEnv.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE = (name: string): string => fileURLToPath(new URL(`../testkit/${name}`, import.meta.url));

function router(dir: string, argv: string[], fake = 'fakeCodex.mjs', extra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [ENTRY, ...argv], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv({ ROUTER_CODEX_BIN: FAKE(fake), ...extra }),
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

// The brief lives outside the checkout: a file written inside it would itself make the tree dirty.
function setup(): { dir: string; brief: string; cleanup(): void } {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const scratch = mkdtempSync(join(tmpdir(), 'router-brief-'));
  const brief = join(scratch, 'BRIEF.md');
  writeFileSync(brief, 'Change x to 2 in src/a.ts.\n');
  return {
    dir,
    brief,
    cleanup() {
      fx.cleanup(dir);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function record(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.router', 'writes', id, 'record.json'), 'utf8')) as Record<string, unknown>;
}

test('write runs codex on the current branch and records its session, commits and base', () => {
  const s = setup();
  try {
    const base = fx.git(s.dir, ['rev-parse', 'HEAD']).trim();
    const branch = fx.git(s.dir, ['symbolic-ref', '--short', 'HEAD']).trim();
    const r = router(s.dir, ['write', 'w1', '--brief', s.brief]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /write w1: ok/);

    const rec = record(s.dir, 'w1');
    assert.equal(rec.session_id, 'fake-session-1');
    assert.equal(rec.base_sha, base);
    assert.equal(rec.branch, branch, 'the writer commits where you are -- no branch of its own');
    assert.equal(rec.model, 'fake-model-1', 'the model the stream reports, not only the one asked for');
    assert.equal((rec.commits as string[]).length, 1);
    assert.deepEqual(rec.uncommitted, []);
    assert.equal(rec.resumes, 0);
    // The brief is kept next to the record, verbatim, so a later review can read what was asked.
    assert.equal(readFileSync(join(s.dir, '.router', 'writes', 'w1', 'BRIEF.md'), 'utf8'), 'Change x to 2 in src/a.ts.\n');
    assert.match(readFileSync(join(s.dir, 'src/a.ts'), 'utf8'), /x = 2/);
  } finally {
    s.cleanup();
  }
});

// The old dispatch rescued uncommitted work into a commit of its own first. The writer refuses
// instead, and must do so before anything is launched or recorded.
test('write refuses a dirty tree and launches nothing', () => {
  const s = setup();
  try {
    fx.write(s.dir, 'src/a.ts', 'export const x = 99; // the user is mid-edit\n');
    const r = router(s.dir, ['write', 'w1', '--brief', s.brief]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /uncommitted change/);
    assert.equal(existsSync(join(s.dir, '.router', 'writes', 'w1')), false);
    assert.match(readFileSync(join(s.dir, 'src/a.ts'), 'utf8'), /x = 99/, "the user's edit is untouched");
  } finally {
    s.cleanup();
  }
});

test('write refuses to reuse an id, pointing at resume', () => {
  const s = setup();
  try {
    assert.equal(router(s.dir, ['write', 'w1', '--brief', s.brief]).code, 0);
    const again = router(s.dir, ['write', 'w1', '--brief', s.brief]);
    assert.equal(again.code, 2, again.out);
    assert.match(again.out, /router resume w1/);
  } finally {
    s.cleanup();
  }
});

test('write refuses a detached HEAD: there is no branch for the writer to commit on', () => {
  const s = setup();
  try {
    fx.git(s.dir, ['checkout', '-q', '--detach', 'HEAD']);
    const r = router(s.dir, ['write', 'w1', '--brief', s.brief]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /detached/);
  } finally {
    s.cleanup();
  }
});

test('resume re-attaches to the same session and keeps counting commits from the original base', () => {
  const s = setup();
  try {
    assert.equal(router(s.dir, ['write', 'w1', '--brief', s.brief]).code, 0);
    const r = router(s.dir, ['resume', 'w1', '--feedback', 'x must be 3']);
    assert.equal(r.code, 0, r.out);
    const rec = record(s.dir, 'w1');
    assert.equal(rec.session_id, 'fake-session-1');
    assert.equal(rec.resumes, 1);
    assert.equal((rec.commits as string[]).length, 2, 'base..HEAD covers both the write and the resume');
    assert.equal(rec.resume_session_mismatch, undefined);
  } finally {
    s.cleanup();
  }
});

test('a resume that reports a different session is not a continuation, and says so', () => {
  const s = setup();
  try {
    assert.equal(router(s.dir, ['write', 'w1', '--brief', s.brief], 'fakeCodexResumeMismatch.mjs').code, 0);
    const r = router(s.dir, ['resume', 'w1', '--feedback', 'again'], 'fakeCodexResumeMismatch.mjs');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /RESUME DID NOT RE-ATTACH/);
    assert.equal(record(s.dir, 'w1').resume_session_mismatch, true);
  } finally {
    s.cleanup();
  }
});

// Measured on the real CLI: a resume handed a flag it rejects dies before the session starts and
// reports no id at all. Absence is not agreement.
test('a resume that reports no session at all is not a continuation either', () => {
  const s = setup();
  try {
    assert.equal(router(s.dir, ['write', 'w1', '--brief', s.brief], 'fakeCodexResumeSilent.mjs').code, 0);
    const r = router(s.dir, ['resume', 'w1', '--feedback', 'again'], 'fakeCodexResumeSilent.mjs');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /RESUME DID NOT RE-ATTACH/);
  } finally {
    s.cleanup();
  }
});

test('resume refuses on a different branch than the write ran on', () => {
  const s = setup();
  try {
    assert.equal(router(s.dir, ['write', 'w1', '--brief', s.brief]).code, 0);
    fx.git(s.dir, ['checkout', '-q', '-b', 'elsewhere']);
    const r = router(s.dir, ['resume', 'w1', '--feedback', 'x must be 3']);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /check it out first/);
    assert.equal(record(s.dir, 'w1').resumes, 0);
  } finally {
    s.cleanup();
  }
});

// The writer's environment carries the sandbox sentinel. A writer that ran `router write` from
// inside its own run would launch a second writer into the same checkout.
test('from inside a writer, router refuses to write but still answers read-only verbs', () => {
  const s = setup();
  try {
    const w = router(s.dir, ['write', 'w1', '--brief', s.brief], 'fakeCodex.mjs', { ROUTER_EXECUTOR_SANDBOX: '1' });
    assert.equal(w.code, 2, w.out);
    assert.match(w.out, /from inside a writer/);
    const m = router(s.dir, ['models'], 'fakeCodex.mjs', { ROUTER_EXECUTOR_SANDBOX: '1' });
    assert.equal(m.code, 0, m.out);
  } finally {
    s.cleanup();
  }
});
