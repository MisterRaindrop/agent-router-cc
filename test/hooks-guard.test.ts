// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../hooks/guard-router-state.mjs', import.meta.url));
const HOOKS_JSON = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));

function guard(toolInput: Record<string, unknown>): number {
  try {
    execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: toolInput }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

test('hooks.json is valid JSON with the PreToolUse guard', () => {
  const h = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  assert.ok(h.hooks.PreToolUse);
});

test('guard blocks edits to managed state files (exit 2)', () => {
  assert.equal(guard({ file_path: '.router/tasks/t1/state.json' }), 2);
  assert.equal(guard({ file_path: '.router/tasks/t1/events.jsonl' }), 2);
  assert.equal(guard({ file_path: '.router/registry.json' }), 2);
  assert.equal(guard({ file_path: '/abs/project/.router/tasks/t1/runs/run-001/result.json' }), 2);
});

test('guard allows editable contract files and non-router paths (exit 0)', () => {
  assert.equal(guard({ file_path: '.router/tasks/t1/task.yaml' }), 0);
  assert.equal(guard({ file_path: '.router/tasks/t1/TASK_CONTRACT.md' }), 0);
  assert.equal(guard({ file_path: '.router/policy.yaml' }), 0);
  assert.equal(guard({ file_path: 'src/main.ts' }), 0);
  assert.equal(guard({}), 0); // no path
});

test('guard allows every artifact the workflow tells the orchestrator to author', () => {
  // Each of these is written by the documented flow, and a name-list guard refused
  // them: TASK_CONTEXT.md (go), gate.yaml (gate), models.yaml (models), the plan
  // directory's critique and decision records (spec/review). Blocking a documented
  // step is worse than not guarding it -- the operator cannot tell a real corruption
  // risk from a stale allow list.
  assert.equal(guard({ file_path: '.router/tasks/t1/TASK_CONTEXT.md' }), 0);
  assert.equal(guard({ file_path: '/abs/project/.router/tasks/t1/TASK_CONTEXT.md' }), 0);
  assert.equal(guard({ file_path: '.router/gate.yaml' }), 0);
  assert.equal(guard({ file_path: '.router/models.yaml' }), 0);
  assert.equal(guard({ file_path: '.router/REPO_NOTES.md' }), 0);
  assert.equal(guard({ file_path: '.router/plans/issue-42/PLAN.md' }), 0);
  assert.equal(guard({ file_path: '.router/plans/issue-42/critique-2.md' }), 0);
  assert.equal(guard({ file_path: '.router/plans/issue-42/DECISIONS.md' }), 0);
});

test('a run directory stays protected even for a markdown name', () => {
  // DELIVERY.md is the executor's own report, written by the CLI from the run log:
  // if an agent could rewrite it, the header that says whether the gate ran would be
  // forgeable, and that header is what the review stage trusts.
  assert.equal(guard({ file_path: '.router/tasks/t1/runs/run-001/DELIVERY.md' }), 2);
  assert.equal(guard({ file_path: '.router/tasks/t1/runs/run-001/diff.patch' }), 2);
  assert.equal(guard({ file_path: '.router/tasks/t1/runs/run-001/logs/worker.log' }), 2);
  // Nor is the plan lock a plan artifact, and root-level state is not config.
  assert.equal(guard({ file_path: '.router/plans/issue-42/spec.lock' }), 2);
  assert.equal(guard({ file_path: '.router/metrics.jsonl' }), 2);
  assert.equal(guard({ file_path: '.router/gate.lock' }), 2);
  assert.equal(guard({ file_path: '.router/symbols/abc123.json' }), 2);
});

test('guard allows edits inside worktree checkouts (exit 0)', () => {
  // The worktree lives under .router/worktrees/ but is the executor's working
  // copy, not router state. Both relative and absolute forms must be allowed,
  // otherwise every dispatch fails when the executor writes to its own checkout.
  assert.equal(guard({ file_path: '.router/worktrees/t1/run-001/src/main.ts' }), 0);
  assert.equal(guard({ file_path: '/abs/project/.router/worktrees/t1/run-001/tests/foo.py' }), 0);
  // Real state under .router/tasks/** stays protected even for a state.json name.
  assert.equal(guard({ file_path: '/abs/project/.router/tasks/t1/state.json' }), 2);
});
