// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_CODEX_MISMATCH = fileURLToPath(new URL('../testkit/fakeCodexResumeMismatch.mjs', import.meta.url));
const FAKE_DELIVERY = fileURLToPath(new URL('./fixtures/fakeCodexDelivery.mjs', import.meta.url));
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
const jsonLine = (out: string): Record<string, unknown> =>
  JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}');

const baseEnv = (dir: string) => ({ ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') });

test('dispatch then resume: re-attaches to the same session and commits the follow-up', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    const d = jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out);
    assert.equal(d.verifier, 'PASSED', JSON.stringify(d));

    const r = router(dir, ['resume', 'demo', '--feedback', 'tighten it', '--json'], env);
    const rj = jsonLine(r.out);
    assert.equal(rj.resumed, true, r.out);
    assert.equal(rj.session_mismatch, false, r.out);
    assert.equal(rj.verifier, 'PASSED', r.out);
    assert.equal(r.code, 0, r.out);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume is fail-loud: a mismatched session id commits nothing and exits non-zero', () => {
  chmodSync(FAKE_CODEX_MISMATCH, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX_MISMATCH, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    router(dir, ['dispatch', 'demo', '--json'], env);

    const r = router(dir, ['resume', 'demo', '--feedback', 'x', '--json'], env);
    const rj = jsonLine(r.out);
    assert.equal(rj.session_mismatch, true, r.out);
    assert.equal(rj.ok, false, r.out);
    assert.equal(r.code, 1, r.out);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume replaces DELIVERY.md with the resumed executor final message', () => {
  chmodSync(FAKE_DELIVERY, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_DELIVERY, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'delivery-valid'], env);
    assert.equal(router(dir, ['dispatch', 'delivery-valid', '--json'], env).code, 0);
    const delivery = join(dir, '.router', 'tasks', 'delivery-valid', 'runs', 'run-001', 'DELIVERY.md');
    assert.match(readFileSync(delivery, 'utf8'), /^Delivery report/);

    const resumed = router(dir, ['resume', 'delivery-valid', '--feedback', 'finish', '--json'], env);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(readFileSync(delivery, 'utf8'), /^Resumed delivery/);
    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-valid', 'runs', 'run-001', 'result.json'), 'utf8'),
    ) as { delivery: { header: { task: string }; header_error?: string } };
    assert.equal(result.delivery.header.task, 'delivery-valid');
    assert.equal(result.delivery.header_error, undefined);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume without a prior dispatch errors clearly', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo']);
    const r = router(dir, ['resume', 'demo', '--feedback', 'x']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /no prior dispatch|resume/i);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume requires --feedback', () => {
  const dir = fx.initRepo();
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo']);
    const r = router(dir, ['resume', 'demo']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /feedback/i);
  } finally {
    fx.cleanup(dir);
  }
});

// Measured: `codex exec resume` rejects flags that `codex exec` accepts, and such a run dies
// before the session starts, reporting no session id at all. The old guard read that absence
// as agreement and committed the work; it must fail loud instead.
test('a resume that reports no session id is not treated as re-attached', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const bin = fileURLToPath(new URL('../testkit/fakeCodexResumeSilent.mjs', import.meta.url));
  chmodSync(bin, 0o755);
  const env = { ROUTER_CODEX_BIN: bin, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'silent'], env);
    assert.equal(router(dir, ['dispatch', 'silent', '--json'], env).code, 0);
    const r = router(dir, ['resume', 'silent', '--feedback', 'try again', '--json'], env);
    assert.equal(r.code, 1, r.out);
    const out = JSON.parse(r.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '{}') as Record<string, unknown>;
    assert.equal(out.session_mismatch, true);
    // Nothing may be committed under a continuity claim nothing supports.
    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'silent', 'runs', 'run-001', 'result.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(result.resume_session_mismatch, true);
    assert.equal(result.resume_reported_session, null);
    assert.equal(result.verifier, undefined);
  } finally {
    fx.cleanup(dir);
  }
});
