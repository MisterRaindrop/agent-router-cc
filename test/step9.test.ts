// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instantiateTemplate, validatePlaceholderValue } from '../src/core/whitelist.ts';
import { runCommand } from '../src/io/proc.ts';
import { buildWorkerEnv } from '../src/io/env.ts';

// -- whitelist --
test('instantiate substitutes placeholders and keeps literals', () => {
  const r = instantiateTemplate(['cmake', '--build', '{build_dir}'], { build_dir: 'build' });
  assert.deepEqual(r.argv, ['cmake', '--build', 'build']);
  assert.ok(r.ok);
});

test('missing param is an error', () => {
  const r = instantiateTemplate(['ctest', '--test-dir', '{d}'], {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('missing verification_param: d')));
});

test('placeholder value cannot start with - (option injection)', () => {
  const r = instantiateTemplate(['make', '{target}'], { target: '--version' });
  assert.equal(r.ok, false);
});

test('placeholder value cannot escape the worktree (absolute or ..)', () => {
  assert.ok(validatePlaceholderValue('d', '/etc/passwd').length > 0);
  assert.ok(validatePlaceholderValue('d', '../../secrets').length > 0);
  assert.equal(validatePlaceholderValue('d', 'build/out').length, 0);
});

test('program (argv[0]) may not be a placeholder', () => {
  const r = instantiateTemplate(['{prog}', 'x'], { prog: 'rm' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('argv[0]')));
});

test('control characters in a value are rejected', () => {
  assert.ok(validatePlaceholderValue('d', 'a\nb').length > 0);
});

// -- proc --
test('runCommand runs argv with shell:false; captures rc/stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-proc-'));
  try {
    const r = runCommand(['node', '-e', 'console.log("hi")'], { cwd: dir, env: process.env });
    assert.equal(r.rc, 0);
    assert.equal(r.stdout.trim(), 'hi');
    assert.equal(r.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand does NOT interpret shell metacharacters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-proc-'));
  try {
    // If a shell were involved, `; echo pwned` would run as a second command.
    // With shell:false the whole string arrives as one literal argv element, so
    // stdout is EXACTLY that string (echoed as data), proving no shell ran it.
    const r = runCommand(['node', '-e', 'process.stdout.write(process.argv[1]||"")', '; echo pwned'], {
      cwd: dir,
      env: process.env,
    });
    assert.equal(r.rc, 0);
    assert.equal(r.stdout, '; echo pwned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand reports nonzero exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-proc-'));
  try {
    const r = runCommand(['node', '-e', 'process.exit(3)'], { cwd: dir, env: process.env });
    assert.equal(r.rc, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand times out a slow command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-proc-'));
  try {
    const r = runCommand(['node', '-e', 'setTimeout(()=>{}, 10000)'], {
      cwd: dir,
      env: process.env,
      timeoutMs: 200,
    });
    assert.equal(r.timedOut, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand reports a spawn error for a missing program', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-proc-'));
  try {
    const r = runCommand(['definitely-not-a-real-binary-xyz'], { cwd: dir, env: process.env });
    assert.ok(r.spawnError !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- env whitelist --
test('buildWorkerEnv passes only base vars + the one API key, drops secrets', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'C',
    OPENAI_API_KEY: 'sk-worker',
    ANTHROPIC_API_KEY: 'sk-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
  } as NodeJS.ProcessEnv;
  const env = buildWorkerEnv(source, ['OPENAI_API_KEY']);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENAI_API_KEY, 'sk-worker');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});
