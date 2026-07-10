// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countsAsAttempt, reclassifyQuota } from '../src/core/exitTaxonomy.ts';

test('countsAsAttempt: env_error and quota_exhausted do not count', () => {
  assert.equal(countsAsAttempt('ok'), true);
  assert.equal(countsAsAttempt('task_failed'), true);
  assert.equal(countsAsAttempt('timeout'), true);
  assert.equal(countsAsAttempt('env_error'), false);
  assert.equal(countsAsAttempt('quota_exhausted'), false);
});

test('reclassifyQuota only touches task_failed/worker_crash when the log matches', () => {
  assert.equal(reclassifyQuota('task_failed', 'Error: 429 rate limit exceeded'), 'quota_exhausted');
  assert.equal(reclassifyQuota('worker_crash', 'usage_limit_reached'), 'quota_exhausted');
  // no quota signature -> unchanged
  assert.equal(reclassifyQuota('task_failed', 'AssertionError: expected 2'), 'task_failed');
  // non-failure classes are never reclassified, even if the text matches
  assert.equal(reclassifyQuota('ok', 'rate limit'), 'ok');
  assert.equal(reclassifyQuota('timeout', 'rate limit'), 'timeout');
});

test('reclassifyQuota honors a custom pattern', () => {
  assert.equal(reclassifyQuota('task_failed', 'OUT OF CREDITS', 'out of credits'), 'quota_exhausted');
  assert.equal(reclassifyQuota('task_failed', 'OUT OF CREDITS'), 'task_failed'); // default pattern misses it
});
