// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt } from '../src/core/planPrompt.ts';
import { parseAndCheck } from '../src/core/planCheck.ts';
import type { RepoDigest } from '../src/domain/types.ts';

const digest: RepoDigest = {
  files: ['src/a.ts', 'test/a.test.ts'],
  truncated: false,
  verificationRefs: ['build', 'test'],
  readmeHead: '# demo',
};

test('buildPlannerPrompt asks for a task batch with clarity and depends_on', () => {
  const p = buildPlannerPrompt(digest, 'make a() faster');
  assert.match(p, /make a\(\) faster/);
  assert.match(p, /build, test/); // the legal verification refs
  assert.match(p, /src\/a\.ts/); // repo files
  assert.match(p, /bare "\*\*"/); // the scope constraint is stated
  assert.match(p, /"tasks"/); // batch envelope
  assert.match(p, /clarity/);
  assert.match(p, /depends_on/);
});

const CTX = { policyRefs: ['build', 'test'], trackedFiles: ['src/a.ts', 'src/b.ts', 'test/a.test.ts'] };
const good = {
  id: 'speed-up-a',
  title: 'Speed up a()',
  allowed_globs: ['src/**'],
  forbidden_globs: [],
  max_changed_lines: 80,
  build_ref: 'build',
  test_ref: 'test',
  contract_md: '# Speed up a()\n\n- [ ] faster',
};
const raw = (o: unknown): string => JSON.stringify(o);

test('parseAndCheck accepts a well-formed contract', () => {
  const r = parseAndCheck(raw(good), CTX);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.contract.id, 'speed-up-a');
});

test('parseAndCheck tolerates surrounding prose and extracts the JSON object', () => {
  const r = parseAndCheck('Here is the plan:\n' + raw(good) + '\nDone.', CTX);
  assert.equal(r.ok, true);
});

test('parseAndCheck rejects an unknown build_ref', () => {
  const r = parseAndCheck(raw({ ...good, build_ref: 'nope' }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('build_ref')));
});

test('parseAndCheck rejects a bare ** glob', () => {
  const r = parseAndCheck(raw({ ...good, allowed_globs: ['**'] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('too broad')));
});

test('parseAndCheck rejects a glob matching no tracked file', () => {
  const r = parseAndCheck(raw({ ...good, allowed_globs: ['docs/**'] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('matches no tracked file')));
});

test('parseAndCheck rejects a non-positive / oversized max_changed_lines', () => {
  assert.equal(parseAndCheck(raw({ ...good, max_changed_lines: 0 }), CTX).ok, false);
  assert.equal(parseAndCheck(raw({ ...good, max_changed_lines: 999999 }), CTX).ok, false);
});

test('parseAndCheck rejects unparseable / non-JSON output', () => {
  assert.equal(parseAndCheck('sorry, I cannot do that', CTX).ok, false);
});

test('parseAndCheck rejects a missing field', () => {
  const { contract_md, ...missing } = good;
  void contract_md;
  const r = parseAndCheck(raw(missing), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('contract_md')));
});
