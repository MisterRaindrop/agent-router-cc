// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStatusLine, statusLineInvocation } from '../src/core/statuslineSetup.ts';

const P = '/plugins/router/statusline/router-usage.mjs';

test('created: no existing statusline -> bare wrapper command', () => {
  const plan = planStatusLine(undefined, P);
  assert.equal(plan.action, 'created');
  assert.equal(plan.inner, null);
  assert.equal(plan.command, `node '${P}'`);
  assert.deepEqual(plan.statusLine, {
    type: 'command',
    command: `node '${P}'`,
    refreshInterval: 10,
  });
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
  const plan = planStatusLine(existing, P, { type: 'command', refreshInterval: 2 });
  assert.equal(plan.action, 'already-configured');
  assert.equal(plan.command, existing); // idempotent: never double-wrapped
});

test('updated: a current command missing refreshInterval is repaired', () => {
  const current = `node '${P}'`;
  const plan = planStatusLine(current, P, { type: 'command' });
  assert.equal(plan.action, 'updated');
  assert.deepEqual(plan.statusLine, {
    type: 'command',
    command: current,
    refreshInterval: 10,
  });
});

test('a refreshInterval the user chose is carried through, not replaced', () => {
  const current = `node '${P}'`;
  const kept = planStatusLine(current, P, { type: 'command', refreshInterval: 10 });
  assert.equal(kept.action, 'already-configured');
  assert.equal(kept.statusLine.refreshInterval, 10);

  // Anything that is not a positive finite number is not a choice, so we supply the default.
  for (const bad of ['fast', 0, -1, Number.NaN, null, undefined]) {
    const plan = planStatusLine(current, P, { type: 'command', refreshInterval: bad });
    assert.equal(plan.action, 'updated', `refreshInterval ${String(bad)} should be replaced`);
    assert.equal(plan.statusLine.refreshInterval, 10);
  }
});

test('updated: all three managed fields must match for an idempotent plan', () => {
  const current = `node '${P}'`;
  assert.equal(planStatusLine(current, P, { type: 'prompt', refreshInterval: 2 }).action, 'updated');
});

// --- Surviving a plugin upgrade ------------------------------------------------------------
//
// An installed plugin lives under a directory named for its version, so an absolute path in
// settings.json pins the statusline to one release. The next upgrade installs beside it and the
// old directory stays, so the pinned path keeps working -- running last release's script, forever,
// silently. This project has now shipped that failure twice (a bundle self-reporting the previous
// version; a statusline scanning a path that had moved) and both times it went unnoticed because
// nothing broke.

const INSTALLED = '/home/u/.claude/plugins/cache/agent-router-cc/router/0.10.1/statusline/router-usage.mjs';
const INSTALLED_OLD = '/home/u/.claude/plugins/cache/agent-router-cc/router/0.10.0/statusline/router-usage.mjs';

test('an installed plugin path resolves the newest version at run time, not at setup time', () => {
  const cmd = statusLineInvocation(INSTALLED);
  // The version this was generated from must NOT appear -- that is the whole point.
  assert.doesNotMatch(cmd, /0\.10\.1/);
  assert.match(cmd, /plugins\/cache\/agent-router-cc\/router/);
  // Numeric field sort, so 0.10.1 beats 0.8.5. A lexical sort would pick 0.8.5.
  assert.match(cmd, /sort -t\. -k1,1n -k2,2n -k3,3n/);
  // `${d}` and not `$d`, or the shell reads one variable named `dstatusline`.
  assert.match(cmd, /\$\{d\}statusline\/router-usage\.mjs/);
});

test('a non-plugin path is invoked directly -- there is no version directory to resolve', () => {
  assert.equal(
    statusLineInvocation('/repo/agent-router-cc/statusline/router-usage.mjs'),
    `node '/repo/agent-router-cc/statusline/router-usage.mjs'`,
  );
});

// The repair path. This used to report `already-configured` and change nothing, so the one
// obvious fix -- run setup again -- silently did nothing and a stranded statusline could only be
// corrected by hand-editing settings.json.
test('repointed: a version-pinned command from an older release is rewritten', () => {
  const stale = `node '${INSTALLED_OLD}'`;
  const plan = planStatusLine(stale, INSTALLED);
  assert.equal(plan.action, 'repointed');
  assert.equal(plan.inner, null);
  assert.doesNotMatch(plan.command, /0\.10\.0/);
  assert.equal(plan.command, statusLineInvocation(INSTALLED));
});

test('repointing carries the chained inner statusline across', () => {
  const stale = `ROUTER_INNER_STATUSLINE='my-hud --fancy' node '${INSTALLED_OLD}'`;
  const plan = planStatusLine(stale, INSTALLED);
  assert.equal(plan.action, 'repointed');
  assert.equal(plan.inner, 'my-hud --fancy');
  assert.match(plan.command, /^ROUTER_INNER_STATUSLINE='my-hud --fancy' sh -c /);
});

test('repointing survives a quote in the chained command', () => {
  const inner = `sh -c 'echo it'\\''s fine'`;
  const stale = `ROUTER_INNER_STATUSLINE='${inner.replaceAll(`'`, `'\\''`)}' node '${INSTALLED_OLD}'`;
  const plan = planStatusLine(stale, INSTALLED);
  assert.equal(plan.action, 'repointed');
  assert.equal(plan.inner, inner);
});

// Still idempotent where it should be: the command we would write now is left alone, chained or
// not, so re-running setup is free rather than churning settings.json.
test('already-configured: the command we would write now is left untouched', () => {
  const current = statusLineInvocation(INSTALLED);
  assert.deepEqual(planStatusLine(current, INSTALLED, { type: 'command', refreshInterval: 2 }), {
    command: current,
    statusLine: { type: 'command', command: current, refreshInterval: 2 },
    action: 'already-configured',
    inner: null,
  });
  const chained = `ROUTER_INNER_STATUSLINE='my-hud' ${current}`;
  assert.deepEqual(planStatusLine(chained, INSTALLED, { type: 'command', refreshInterval: 2 }), {
    command: chained,
    statusLine: { type: 'command', command: chained, refreshInterval: 2 },
    action: 'already-configured',
    inner: null,
  });
});
