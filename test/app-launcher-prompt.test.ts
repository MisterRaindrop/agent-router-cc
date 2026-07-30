// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// The executor prompt is a contract, not prose: it tells the executor to own the whole
// implement-test-gate-fix loop, forbids provisioning the environment, forbids quietly
// working around a wrong contract, and specifies the delivery report that replaces raw
// log reading. Each of those is asserted here because a silent regression in any of them
// costs the orchestrator turns without failing anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskYaml } from '../src/domain/types.ts';
import { claudeLauncher, codexLauncher } from '../src/app/codexLauncher.ts';

const TASK: TaskYaml = {
  schema_version: 1,
  id: 'demo',
  title: 'demo task',
  base_sha: null,
  plan_id: 'plan-7',
  max_wall_minutes: 30,
  allowed_globs: ['src/**'],
  verify: [['npm', 'run', 'check']],
};

function prompt(task: TaskYaml): string {
  const argv = codexLauncher({ model: 'm', effort: 'high' }).buildArgv({
    task,
    worktreeDir: '/wt',
    contractMdText: '# Contract\nDo the thing.',
    planExists: false,
  });
  return argv[2]!;
}

test('the prompt hands the executor the whole loop and names the gate it must run', () => {
  const p = prompt(TASK);
  assert.match(p, /# Contract\nDo the thing\./); // contract first, verbatim
  assert.match(p, /You own this task start to finish/);
  assert.match(p, /run the project gate yourself \(`npm run check`\)/);
  assert.match(p, /fix until it passes/);
});

test('with no verify configured, the prompt says so instead of naming a gate', () => {
  const p = prompt({ ...TASK, verify: [] });
  assert.match(p, /NO gate runs here/);
  assert.doesNotMatch(p, /run the project gate yourself/);
});

test('the prompt forbids provisioning the environment and faking a pass', () => {
  const p = prompt(TASK);
  assert.match(p, /Do NOT set up the environment/);
  assert.match(p, /no installing dependencies/);
  assert.match(p, /a claimed pass that never ran is not/);
});

test('the prompt forbids changing the plan and specifies CONTRACT_CONFLICT', () => {
  const p = prompt(TASK);
  assert.match(p, /Do NOT change the plan or this contract/);
  assert.match(p, /begin with the\n  single line CONTRACT_CONFLICT/);
  // The conflict report must carry evidence and impact, not just a refusal.
  for (const field of ['the original assumption', 'the evidence you', 'which other work this affects']) {
    assert.ok(p.includes(field), `conflict protocol is missing "${field}"`);
  }
});

test('the prompt specifies the delivery report block with the task and plan bound in', () => {
  const p = prompt(TASK);
  assert.match(p, /```router-delivery\ntask: demo\nplan_revision: plan-7\n/);
  for (const key of ['gate_ran: true|false', 'scope_drift: true|false', 'escalate_review: true|false']) {
    assert.ok(p.includes(key), `delivery header is missing "${key}"`);
  }
});

test('a task with no plan_id reports plan_revision none rather than an empty value', () => {
  const { plan_id: _dropped, ...noPlan } = TASK;
  assert.match(prompt(noPlan as TaskYaml), /plan_revision: none\n/);
});

test('the original scope constraints survive, and both launchers share the prompt', () => {
  const p = prompt(TASK);
  assert.match(p, /Change ONLY files matching: src\/\*\*/);
  assert.match(p, /Do not touch tests except to make them pass legitimately/);
  assert.match(p, /Leave changes in the working tree/);

  const claudeArgv = claudeLauncher({ model: 'sonnet' }).buildArgv({
    task: TASK,
    worktreeDir: '/wt',
    contractMdText: '# Contract\nDo the thing.',
    planExists: false,
  });
  assert.equal(claudeArgv[claudeArgv.indexOf('-p') + 1], p);
});
