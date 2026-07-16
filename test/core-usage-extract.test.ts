// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../src/core/usageExtract.ts';

test('extractUsage reads a codex-like rate_limits.primary', () => {
  const u = extractUsage({ rate_limits: { primary: { used_percent: 42, resets_at: 99 }, rate_limit_reached_type: null } });
  assert.deepEqual(u, { used_percent: 42, resets_at: 99, reached: false });
});

test('extractUsage reads a remaining_percentage form', () => {
  assert.equal(extractUsage({ rate_limits: { remaining_percentage: 30 } })?.used_percent, 70);
});

test('extractUsage finds rate_limits nested in a payload', () => {
  const u = extractUsage({ session: { x: 1 }, data: { rate_limits: { used_percent: 12 } } });
  assert.equal(u?.used_percent, 12);
});

test('extractUsage marks reached at 100%', () => {
  assert.equal(extractUsage({ rate_limits: { primary: { used_percent: 100 } } })?.reached, true);
});

test('extractUsage returns null when nothing recognizable is present', () => {
  assert.equal(extractUsage({ foo: 1, context_window: { size: 1000 } }), null);
  assert.equal(extractUsage('not an object'), null);
});
