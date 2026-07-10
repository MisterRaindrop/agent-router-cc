// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import { routerPaths } from '../src/io/paths.ts';
import { systemClock } from '../src/io/clock.ts';
import { runPlan } from '../src/app/plan.ts';

const FAKE = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));

function repo(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/slugify.mjs', 'export const x=1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    'schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - ["node", "-e", "0"]\n  test:\n    - ["node", "-e", "0"]\n',
  );
  fx.addCommit(dir, 'base');
  return dir;
}

test('runPlan materializes a DRAFT task from a valid claude proposal', () => {
  const dir = repo();
  const prev = process.env.ROUTER_CLAUDE_BIN;
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'valid';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'implement slugify');
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.id, 'slugify');
      assert.ok(existsSync(paths.taskYaml('slugify')));
      assert.match(readFileSync(paths.contractMd('slugify'), 'utf8'), /Implement slugify/);
    }
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CLAUDE_BIN;
    else process.env.ROUTER_CLAUDE_BIN = prev;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});

test('runPlan rejects an invalid proposal without creating a task', () => {
  const dir = repo();
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'badref';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'implement slugify');
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.errors.some((e) => e.includes('build_ref')));
    assert.equal(existsSync(paths.taskDir('slugify')), false);
  } finally {
    delete process.env.ROUTER_CLAUDE_BIN;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});
