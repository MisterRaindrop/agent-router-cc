// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from '../src/core/secrets.ts';

// A minimal unified-diff builder: each line becomes an added ('+') line.
const added = (...lines: string[]): string =>
  ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -0,0 +1 @@', ...lines.map((l) => `+${l}`)].join('\n');

test('flags an AWS access key id', () => {
  const f = scanSecrets(added('const k = "AKIAIOSFODNN7EXAMPLE";'));
  assert.equal(f.length, 1);
  assert.equal(f[0]?.rule, 'aws_access_key');
});

test('flags a PEM private-key header', () => {
  const f = scanSecrets(added('-----BEGIN OPENSSH PRIVATE KEY-----'));
  assert.equal(f.some((x) => x.rule === 'private_key_header'), true);
});

test('flags a high-entropy secret assignment', () => {
  const f = scanSecrets(added('api_key = "abc123DEF456ghi789JKL012"'));
  assert.equal(f.some((x) => x.rule === 'secret_assignment'), true);
});

test('does NOT flag ordinary code or prose (conservative)', () => {
  const clean = added(
    'export const x = 2;',
    'const token = "the quick brown fox jumps over";', // no digits -> not entropy-like
    'let count = 0;',
    'function secret() { return 1; }', // "secret" but no quoted value
  );
  assert.deepEqual(scanSecrets(clean), []);
});

test('only scans added lines, not context or removed lines', () => {
  const diff = [
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    '@@ -1,2 +1,2 @@',
    ' const ctx = "AKIAIOSFODNN7EXAMPLE";', // context line (leading space) - ignored
    '-const old = "AKIAIOSFODNN7EXAMPLE";', // removed line - ignored
    '+const kept = "safe value here";',
  ].join('\n');
  assert.deepEqual(scanSecrets(diff), []);
});

test('extra_patterns extend the scan', () => {
  const f = scanSecrets(added('internal_marker=DEPLOYKEY'), ['DEPLOYKEY']);
  assert.equal(f.some((x) => x.rule === 'custom_pattern[0]'), true);
});

test('the redacted snippet does not leak the full secret', () => {
  const f = scanSecrets(added('api_key = "abc123DEF456ghi789JKL012MNO"'));
  assert.equal(f.length >= 1, true);
  assert.equal(f[0]?.snippet.includes('MNO'), false); // tail is truncated
});
