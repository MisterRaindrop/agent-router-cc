// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStatusLine } from '../src/core/statuslineSetup.ts';

const P = '/plugins/router/statusline/router-usage.mjs';

test('created: no existing statusline -> bare wrapper command', () => {
  const plan = planStatusLine(undefined, P);
  assert.equal(plan.action, 'created');
  assert.equal(plan.inner, null);
  assert.equal(plan.command, `node '${P}'`);
});

test('empty existing command is treated as created', () => {
  assert.equal(planStatusLine('   ', P).action, 'created');
});

test('chained: an existing statusline is preserved via ROUTER_INNER_STATUSLINE', () => {
  const plan = planStatusLine('npx ccusage statusline', P);
  assert.equal(plan.action, 'chained');
  assert.equal(plan.inner, 'npx ccusage statusline');
  assert.equal(plan.command, `ROUTER_INNER_STATUSLINE='npx ccusage statusline' node '${P}'`);
});

test('chaining shell-escapes single quotes in the existing command', () => {
  const plan = planStatusLine(`echo 'hi there'`, P);
  assert.equal(plan.command, `ROUTER_INNER_STATUSLINE='echo '\\''hi there'\\''' node '${P}'`);
});

test('already-configured: a command that already runs our wrapper is left untouched', () => {
  const existing = `ROUTER_INNER_STATUSLINE='npx ccusage' node '${P}'`;
  const plan = planStatusLine(existing, P);
  assert.equal(plan.action, 'already-configured');
  assert.equal(plan.command, existing); // idempotent: never double-wrapped
});
