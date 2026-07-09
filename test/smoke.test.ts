// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUNDLE = fileURLToPath(new URL('../dist/router.js', import.meta.url));

test('dist/router.js exists (committed bundle)', () => {
  assert.ok(existsSync(BUNDLE), 'run `npm run build` to produce dist/router.js');
});

test('router --version prints the package version on bare Node', () => {
  const out = execFileSync('node', [BUNDLE, '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test('router with no args prints help and exits non-zero', () => {
  assert.throws(
    () => execFileSync('node', [BUNDLE], { encoding: 'utf8', stdio: 'pipe' }),
    (err: unknown) => (err as { status?: number }).status === 1,
  );
});

test('router unknown command exits 2', () => {
  assert.throws(
    () => execFileSync('node', [BUNDLE, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    (err: unknown) => (err as { status?: number }).status === 2,
  );
});
