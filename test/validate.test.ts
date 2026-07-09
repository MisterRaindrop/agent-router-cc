import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, JSON_SCHEMA } from 'js-yaml';
import { validatePolicy, validateTaskYaml } from '../src/domain/validate.ts';

const parse = (s: string): unknown => load(s, { schema: JSON_SCHEMA });

const GOOD_POLICY = `
schema_version: 1
max_concurrent_workers: 1
worker:
  kind: codex
  api_key_env: OPENAI_API_KEY
  max_wall_minutes_default: 30
  stall_minutes: 10
scope:
  forbidden_globs: ["**/*.lock", ".router/**"]
  test_globs: ["tests/**"]
  max_changed_lines: 400
verification:
  build:
    - ["cmake", "--build", "{build_dir}"]
  test:
    - ["ctest", "--test-dir", "{build_dir}"]
escalation:
  max_attempts: 3
`;

const GOOD_TASK = `
schema_version: 1
id: fix-btree-underflow
title: "Fix B-tree page underflow"
base_sha: null
max_wall_minutes: 30
allowed_globs: ["src/**", "tests/**"]
forbidden_globs: ["src/wal/**"]
max_changed_lines: 200
build_ref: build
test_ref: test
verification_params:
  build_dir: build
`;

test('valid policy round-trips', () => {
  const r = validatePolicy(parse(GOOD_POLICY));
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.value?.scope.max_changed_lines, 400);
  assert.deepEqual(r.value?.verification.build, [['cmake', '--build', '{build_dir}']]);
});

test('valid task round-trips (base_sha null pre-validate)', () => {
  const r = validateTaskYaml(parse(GOOD_TASK));
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.value?.base_sha, null);
  assert.equal(r.value?.build_ref, 'build');
});

test('task with a filled 40-hex base_sha validates', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  t.base_sha = 'a'.repeat(40);
  const r = validateTaskYaml(t);
  assert.ok(r.ok, r.errors.join('; '));
});

test('policy rejects unknown schema_version', () => {
  const p = parse(GOOD_POLICY) as Record<string, unknown>;
  p.schema_version = 2;
  const r = validatePolicy(p);
  assert.equal(r.ok, false);
});

test('policy rejects unknown top-level key (additionalProperties false)', () => {
  const p = parse(GOOD_POLICY) as Record<string, unknown>;
  p.sneaky = true;
  const r = validatePolicy(p);
  assert.equal(r.ok, false);
});

test('policy rejects non-codex worker kind', () => {
  const p = parse(GOOD_POLICY) as Record<string, unknown>;
  (p.worker as Record<string, unknown>).kind = 'evil';
  const r = validatePolicy(p);
  assert.equal(r.ok, false);
});

test('task rejects missing required field', () => {
  const t = parse(GOOD_TASK) as Record<string, unknown>;
  delete t.build_ref;
  const r = validateTaskYaml(t);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('build_ref')));
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
