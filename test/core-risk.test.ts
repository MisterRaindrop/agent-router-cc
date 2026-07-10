// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk } from '../src/core/risk.ts';

test('a scoped src-only task is low risk', () => {
  const r = classifyRisk(['src/**', 'tests/**']);
  assert.equal(r.level, 'low');
  assert.deepEqual(r.reasons, []);
});

test('touching package.json is high risk', () => {
  const r = classifyRisk(['src/**', 'package.json']);
  assert.equal(r.level, 'high');
  assert.ok(r.reasons.includes('package.json'));
});

test('a lockfile glob is high risk', () => {
  assert.equal(classifyRisk(['**/*.lock']).level, 'high');
});

test('.github CI config is high risk', () => {
  const r = classifyRisk(['.github/**']);
  assert.equal(r.level, 'high');
  assert.ok(r.reasons.some((x) => x.includes('.github')));
});

test('migrations are high risk', () => {
  assert.equal(classifyRisk(['migrations/**']).level, 'high');
});

test('an over-broad ** glob (can touch everything) is high risk', () => {
  assert.equal(classifyRisk(['**']).level, 'high');
});

test('reasons are de-duplicated', () => {
  const r = classifyRisk(['**/*.lock']); // matches several lockfile samples
  assert.equal(new Set(r.reasons).size, r.reasons.length);
});
