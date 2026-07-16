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
