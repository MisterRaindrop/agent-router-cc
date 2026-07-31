// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, JSON_SCHEMA } from 'js-yaml';
import { validateTaskYaml } from '../src/domain/validate.ts';

const parse = (s: string): unknown => load(s, { schema: JSON_SCHEMA });

const GOOD_TASK = `
schema_version: 1
id: fix-btree-underflow
title: "Fix B-tree page underflow"
base_sha: null
max_wall_minutes: 30
allowed_globs: ["src/**", "tests/**"]
forbidden_globs: ["src/wal/**"]
max_changed_lines: 200
verify:
  - ["npm", "test"]
`;

test('valid task round-trips (base_sha null pre-dispatch)', () => {
  const r = validateTaskYaml(parse(GOOD_TASK));
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.value?.base_sha, null);
  assert.deepEqual(r.value?.verify, [['npm', 'test']]);
});

test('task accepts an optional plan_id without requiring one', () => {
  const withPlanId = parse(GOOD_TASK) as Record<string, unknown>;
  withPlanId.plan_id = 'plan-123';
  const withPlanIdResult = validateTaskYaml(withPlanId);
  assert.ok(withPlanIdResult.ok, withPlanIdResult.errors.join('; '));
  assert.equal(withPlanIdResult.value?.plan_id, 'plan-123');

  const withoutPlanIdResult = validateTaskYaml(parse(GOOD_TASK));
  assert.ok(withoutPlanIdResult.ok, withoutPlanIdResult.errors.join('; '));
  assert.equal(withoutPlanIdResult.value?.plan_id, undefined);
});

test('task accepts each optional contract metadata field and requires none of them', () => {
  const withMetadata = parse(GOOD_TASK) as Record<string, unknown>;
  Object.assign(withMetadata, {
    plan_revision: 'router-v2-p1',
    depends_on: ['task-a', 'task.b'],
    invariants: ['Do not touch src/core/**'],
    risk: 'high',
    mode: 'probe',
  });
  const withMetadataResult = validateTaskYaml(withMetadata);
  assert.ok(withMetadataResult.ok, withMetadataResult.errors.join('; '));
  assert.equal(withMetadataResult.value?.plan_revision, 'router-v2-p1');
  assert.deepEqual(withMetadataResult.value?.depends_on, ['task-a', 'task.b']);
  assert.deepEqual(withMetadataResult.value?.invariants, ['Do not touch src/core/**']);
  assert.equal(withMetadataResult.value?.risk, 'high');
  assert.equal(withMetadataResult.value?.mode, 'probe');

  const legacyResult = validateTaskYaml(parse(GOOD_TASK));
  assert.ok(legacyResult.ok, legacyResult.errors.join('; '));
  assert.equal(legacyResult.value?.plan_revision, undefined);
  assert.equal(legacyResult.value?.depends_on, undefined);
  assert.equal(legacyResult.value?.invariants, undefined);
  assert.equal(legacyResult.value?.risk, undefined);
  assert.equal(legacyResult.value?.mode, undefined);
});

test('task rejects invalid contract metadata values', () => {
  for (const [field, value] of [
    ['risk', 'medium'],
    ['depends_on', ['../escape']],
    ['depends_on', ['task-a', 'task-a']],
    ['mode', 'review'],
  ] as const) {
    const t = parse(GOOD_TASK) as Record<string, unknown>;
    t[field] = value;
    const r = validateTaskYaml(t);
    assert.equal(r.ok, false, `${field} unexpectedly accepted ${JSON.stringify(value)}`);
  }
});

test('task with a filled 40-hex base_sha validates', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.base_sha = 'a'.repeat(40);
  const r = validateTaskYaml(t);
  assert.ok(r.ok, r.errors.join('; '));
});

test('task rejects an unknown top-level key (additionalProperties false)', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.build_ref = 'build'; // a removed legacy field is now rejected
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
});

test('task rejects missing required field', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  delete t.allowed_globs;
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('allowed_globs')));
});

test('task rejects bad id pattern', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.id = '../escape';
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
});

test('task rejects malformed base_sha', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.base_sha = 'nothex';
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
});

test('task rejects empty allowed_globs', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.allowed_globs = [];
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
});

test('task accepts a valid tier and an effort on worker', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.tier = 'critical';
  t.worker = { kind: 'codex', model: 'gpt-5.6-sol', effort: 'max' };
  const r = validateTaskYaml(t);
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.value?.tier, 'critical');
  assert.equal(r.value?.worker?.effort, 'max');
});

test('task rejects an unknown tier value', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.tier = 'medium'; // only weak|strong|critical allowed
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
});

// `plan_id` doubles as a directory name under `.router/plans/`, so a branch name pasted in
// raw ("feat/x") would quietly create a nested directory -- and once a reviewer reads the plan
// from disk, being handed a different plan is a silent wrong-premise review, not a lost file.
test('plan_id must be path-safe', () => {
  const withPlan = (planId: string): unknown => parse(`${GOOD_TASK}plan_id: ${JSON.stringify(planId)}\n`);

  const ok = validateTaskYaml(withPlan('issue-90731'));
  assert.ok(ok.ok, ok.errors.join('; '));
  assert.equal(ok.value?.plan_id, 'issue-90731');

  for (const bad of ['feat/p2-probe', '', '../escape', '-leading-dash']) {
    const r = validateTaskYaml(withPlan(bad));
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
