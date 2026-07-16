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
