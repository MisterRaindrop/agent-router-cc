#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for `claude -p ... --output-format json`. Ignores args; prints a json
// envelope whose `.result` is a task-contract JSON string. ROUTER_FAKE_PLAN selects
// which payload: valid | badref | broad (bare single objects) | multi (a batch).
const good = {
  id: 'slugify',
  title: 'Implement slugify()',
  allowed_globs: ['src/**'],
  forbidden_globs: [],
  max_changed_lines: 100,
  build_ref: 'build',
  test_ref: 'test',
  contract_md: '# Implement slugify()\n\n## Goal\n\nImplement slugify.\n\n## Definition of Done\n\n- [ ] tests pass\n',
};
const taskA = { ...good, id: 'task-a', clarity: 'clear', depends_on: [] };
const taskB = {
  ...good,
  id: 'task-b',
  title: 'Follow-up on task-a',
  clarity: 'clear',
  depends_on: ['task-a'],
  contract_md: '# Follow-up\n\n## Goal\n\nBuild on task-a.\n\n## Definition of Done\n\n- [ ] done\n',
};
const taskC = { id: 'task-c', title: 'Design the API shape', clarity: 'unclear', reason: 'API shape needs a human decision' };

const mode = process.env.ROUTER_FAKE_PLAN ?? 'valid';
const payload =
  mode === 'multi'
    ? { tasks: [taskA, taskB, taskC] }
    : mode === 'badref'
      ? { ...good, build_ref: 'nope' }
      : mode === 'broad'
        ? { ...good, allowed_globs: ['**'] }
        : good;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(payload) }) + '\n');
process.exit(0);
