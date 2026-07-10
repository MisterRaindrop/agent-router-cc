// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles } from '../src/io/git.ts';
import { invokeClaudePlanner } from '../src/io/claudePlan.ts';
import * as fx from '../testkit/gitRepo.ts';

test('listTrackedFiles returns git-tracked paths', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'src/x.ts', 'export const x = 1;\n');
    fx.addCommit(dir, 'x');
    const r = listTrackedFiles(dir);
    assert.ok(r.files.includes('src/x.ts'));
    assert.equal(r.truncated, false);
  } finally {
    fx.cleanup(dir);
  }
});

test('invokeClaudePlanner reads the .result field of the claude json envelope', () => {
  const FAKE = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));
  const r = invokeClaudePlanner('ignored', { ...process.env, ROUTER_CLAUDE_BIN: FAKE, ROUTER_FAKE_PLAN: 'valid' });
  assert.equal(r.ok, true);
  assert.match(r.text, /"id"\s*:\s*"slugify"/);
});
