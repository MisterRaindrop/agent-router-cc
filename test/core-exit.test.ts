// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countsAsAttempt,
  detectContractConflict,
  detectModelMismatch,
  reclassifyEnvironmentFailure,
  reclassifyQuota,
} from '../src/core/exitTaxonomy.ts';

test('countsAsAttempt: env_error and quota_exhausted do not count', () => {
  assert.equal(countsAsAttempt('ok'), true);
  assert.equal(countsAsAttempt('task_failed'), true);
  assert.equal(countsAsAttempt('timeout'), true);
  assert.equal(countsAsAttempt('env_error'), false);
  assert.equal(countsAsAttempt('quota_exhausted'), false);
  assert.equal(countsAsAttempt('contract_conflict'), false);
});

test('detectContractConflict only accepts the protocol marker on the first non-empty line', () => {
  assert.equal(detectContractConflict('CONTRACT_CONFLICT\nDetails follow.'), true);
  assert.equal(detectContractConflict('\n  \r\nCONTRACT_CONFLICT:\nDetails follow.'), true);
  assert.equal(detectContractConflict('CONTRACT_CONFLICT.\nDetails follow.'), true);
  assert.equal(detectContractConflict('Summary first.\nCONTRACT_CONFLICT'), false);
  assert.equal(detectContractConflict('This report discusses CONTRACT_CONFLICT later.'), false);
  assert.equal(detectContractConflict(null), false);
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

test('provider authentication failures are reclassified as env_error', () => {
  assert.equal(reclassifyEnvironmentFailure('task_failed', 'Not logged in · Please run /login'), 'env_error');
  assert.equal(reclassifyEnvironmentFailure('worker_crash', 'error=authentication_failed'), 'env_error');
  assert.equal(reclassifyEnvironmentFailure('task_failed', 'Failed to authenticate. API Error: 403'), 'env_error');
  assert.equal(reclassifyEnvironmentFailure('task_failed', 'AssertionError: expected 2'), 'task_failed');
  assert.equal(reclassifyEnvironmentFailure('quota_exhausted', 'Not logged in'), 'quota_exhausted');
});

test('detectModelMismatch flags a rejected slug but not ordinary failures', () => {
  assert.equal(detectModelMismatch('error: unknown model "gpt-5.6-terra"'), true);
  assert.equal(detectModelMismatch('Model not found'), true);
  assert.equal(detectModelMismatch('the model gpt-x is not available on your plan'), true);
  assert.equal(detectModelMismatch('invalid model: foo'), true);
  // ordinary test/compile failures must NOT be flagged as a config problem
  assert.equal(detectModelMismatch('AssertionError: expected 2 to equal 3'), false);
  assert.equal(detectModelMismatch('npm test failed with exit code 1'), false);
});
