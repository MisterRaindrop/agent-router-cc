// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

// End-to-end wiring of the exec_bit gate: an executor that adds a script without the
// executable bit, into a directory whose scripts are executable, must be rejected -- and
// the same diff WITH the bit must pass. This is the mistake a real (strong) model made:
// the test file was created 100644, so CI would have died with "permission denied"
// before running a single assertion, and no other gate looks at file modes.

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE = fileURLToPath(new URL('../testkit/fakeCodexScript.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/**
 * Repo whose tests/sh/*.sh are all executable -- an established directory convention.
 * `wantExec` commits the marker the fake executor looks for (an env var would not
 * survive router's executor env allow-list).
 */
function repoWithExecutableScripts(wantExec = false): string {
  const dir = fx.initRepo();
  for (const name of ['a', 'b', 'c', 'd']) {
    fx.write(dir, `tests/sh/${name}.sh`, '#!/bin/sh\ntrue\n');
    chmodSync(join(dir, 'tests', 'sh', `${name}.sh`), 0o755);
  }
  if (wantExec) fx.write(dir, 'tests/sh/.want-exec', '');
  fx.addCommit(dir, 'base');
  return dir;
}

/** The --json object, ignoring any git chatter the CLI relays on stderr when it fails. */
function jsonLine(out: string): { verifier: string } {
  const line = out.split('\n').find((l) => l.trimStart().startsWith('{'));
  assert.ok(line !== undefined, `no JSON object in output: ${out}`);
  return JSON.parse(line) as { verifier: string };
}

function taskAllowingScripts(dir: string): void {
  writeFileSync(
    join(dir, '.router', 'tasks', 'demo', 'task.yaml'),
    'schema_version: 1\nid: demo\ntitle: Demo\nmax_wall_minutes: 5\nallowed_globs:\n  - tests/**\nforbidden_globs: []\nmax_changed_lines: 400\nverify: []\n',
  );
}

test('exec_bit gate rejects a script added without the executable bit', () => {
  chmodSync(FAKE, 0o755);
  const dir = repoWithExecutableScripts();
  const env = { ROUTER_CODEX_BIN: FAKE, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    taskAllowingScripts(dir);
    const d = router(dir, ['dispatch', 'demo', '--json'], env);
    assert.equal(d.code, 1, d.out);
    assert.equal(jsonLine(d.out).verifier, 'FAILED');

    const result = JSON.parse(readFileSync(join(dir, '.router', 'tasks', 'demo', 'result.json'), 'utf8'));
    const check = result.verifier.checks.find((c: { id: string }) => c.id === 'exec_bit');
    assert.ok(check !== undefined, 'exec_bit check must be reported');
    assert.equal(check.ok, false);
    assert.match(check.detail, /tests\/sh\/new\.sh is 100644 but 4\/4 siblings are executable/);
  } finally {
    fx.cleanup(dir);
  }
});

test('exec_bit gate passes the same diff when the bit is set', () => {
  chmodSync(FAKE, 0o755);
  const dir = repoWithExecutableScripts(true); // fixture asks the fake to set the bit
  const env = { ROUTER_CODEX_BIN: FAKE, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    taskAllowingScripts(dir);
    const d = router(dir, ['dispatch', 'demo', '--json'], env);
    assert.equal(d.code, 0, d.out);
    assert.equal(jsonLine(d.out).verifier, 'PASSED');
  } finally {
    fx.cleanup(dir);
  }
});

test('exec_bit gate stays quiet where the directory has no executable convention', () => {
  chmodSync(FAKE, 0o755);
  const dir = fx.initRepo();
  // Sourced shell libraries: same extension, deliberately NOT executable. A new
  // non-executable file here must not be flagged.
  for (const name of ['lib1', 'lib2', 'lib3', 'lib4']) {
    fx.write(dir, `tests/sh/${name}.sh`, '#!/bin/sh\n# sourced, not executed\n');
  }
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    taskAllowingScripts(dir);
    const d = router(dir, ['dispatch', 'demo', '--json'], env);
    assert.equal(d.code, 0, d.out);
    assert.equal(jsonLine(d.out).verifier, 'PASSED');
  } finally {
    fx.cleanup(dir);
  }
});
