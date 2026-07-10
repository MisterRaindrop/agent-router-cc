// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt } from '../src/core/planPrompt.ts';
import type { RepoDigest } from '../src/domain/types.ts';

const digest: RepoDigest = {
  files: ['src/a.ts', 'test/a.test.ts'],
  truncated: false,
  verificationRefs: ['build', 'test'],
  readmeHead: '# demo',
};

test('buildPlannerPrompt embeds the goal, the legal refs, and the file list', () => {
  const p = buildPlannerPrompt(digest, 'make a() faster');
  assert.match(p, /make a\(\) faster/);
  assert.match(p, /build, test/); // the legal verification refs
  assert.match(p, /src\/a\.ts/); // repo files
  assert.match(p, /bare "\*\*"/); // the scope constraint is stated
  assert.match(p, /ONLY a single JSON object/i);
});
