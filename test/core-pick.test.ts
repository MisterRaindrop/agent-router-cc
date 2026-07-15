// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExecutor } from '../src/core/pickExecutor.ts';
import type { ExecutorQuota } from '../src/domain/types.ts';

const q = (kind: 'codex' | 'claude', used_percent: number, resets_at: number | null = null, available = true): ExecutorQuota => ({
  kind,
  used_percent,
  resets_at,
  available,
});

test('pickExecutor chooses the executor with the most headroom (lowest used_percent)', () => {
  assert.equal(pickExecutor([q('codex', 80), q('claude', 30)]), 'claude');
  assert.equal(pickExecutor([q('codex', 20), q('claude', 90)]), 'codex');
});

test('pickExecutor tie-breaks equal usage by soonest reset', () => {
  assert.equal(pickExecutor([q('codex', 50, 2000), q('claude', 50, 1000)]), 'claude');
});

test('pickExecutor skips unavailable executors (hit their limit)', () => {
  assert.equal(pickExecutor([q('codex', 10, null, false), q('claude', 70)]), 'claude');
});

test('pickExecutor returns null when none are available', () => {
  assert.equal(pickExecutor([q('codex', 10, null, false), q('claude', 20, null, false)]), null);
});

test('pickExecutor returns null on an empty list', () => {
  assert.equal(pickExecutor([]), null);
});

test('pickExecutor preserves first-listed order when usage and reset are equal', () => {
  // deterministic: equal on all keys -> first in the input wins (stable)
  assert.equal(pickExecutor([q('codex', 40, 5000), q('claude', 40, 5000)]), 'codex');
});
