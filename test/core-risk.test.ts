// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRisk } from '../src/core/risk.ts';

test('effectiveRisk raises an invariant hit to high using the shared glob semantics', () => {
  assert.deepEqual(
    effectiveRisk('low', {
      changedLines: 2,
      changedPaths: ['src/core/risk.ts'],
      invariantGlobs: ['src/core/**'],
    }),
    { risk: 'high', raisedBy: ['invariant:src/core/**'] },
  );
});

test('effectiveRisk raises low risk for a large or broadly spread change', () => {
  assert.deepEqual(
    effectiveRisk('low', {
      changedLines: 301,
      changedPaths: ['src/a.ts'],
      invariantGlobs: [],
    }),
    { risk: 'normal', raisedBy: ['changed_lines>300'] },
  );
  assert.deepEqual(
    effectiveRisk('low', {
      changedLines: 4,
      changedPaths: ['src/a.ts', 'test/a.ts', 'docs/a.md', 'scripts/a.mjs'],
      invariantGlobs: [],
    }),
    { risk: 'normal', raisedBy: ['top_level_directories>=4'] },
  );
});

test('effectiveRisk defaults to normal and never lowers a declared high', () => {
  assert.deepEqual(
    effectiveRisk(undefined, { changedLines: 1, changedPaths: ['src/a.ts'], invariantGlobs: [] }),
    { risk: 'normal', raisedBy: [] },
  );
  assert.deepEqual(
    effectiveRisk('high', { changedLines: 301, changedPaths: ['src/a.ts'], invariantGlobs: [] }),
    { risk: 'high', raisedBy: ['changed_lines>300'] },
  );
});
