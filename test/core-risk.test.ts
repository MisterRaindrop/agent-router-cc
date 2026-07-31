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
  // A tripwire that fires while the declared level is already higher raises nothing, so it
  // is not reported as having raised anything (see the `raisedBy` test below).
  assert.deepEqual(
    effectiveRisk('high', { changedLines: 301, changedPaths: ['src/a.ts'], invariantGlobs: [] }),
    { risk: 'high', raisedBy: [] },
  );
});

// `raisedBy` is read as "these signals lifted the risk", so it must not list a signal that
// changed nothing -- otherwise the CLI prints "RISK RAISED to high" for a task that simply
// declared `high` in its contract.
test('raisedBy names only the signals that actually lifted the level', () => {
  const alreadyHigh = effectiveRisk('high', {
    changedLines: 900,
    changedPaths: ['a/x.ts', 'b/x.ts', 'c/x.ts', 'd/x.ts'],
    invariantGlobs: ['a/**'],
  });
  assert.equal(alreadyHigh.risk, 'high');
  assert.deepEqual(alreadyHigh.raisedBy, []);

  const lifted = effectiveRisk('low', {
    changedLines: 5,
    changedPaths: ['src/core/glob.ts'],
    invariantGlobs: ['src/core/**'],
  });
  assert.equal(lifted.risk, 'high');
  assert.deepEqual(lifted.raisedBy, ['invariant:src/core/**']);
});
