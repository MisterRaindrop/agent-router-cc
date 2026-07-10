#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for `claude -p ... --output-format json`. Ignores args; prints a json
// envelope whose `.result` is a task-contract JSON string. ROUTER_FAKE_PLAN selects
// which contract: valid | badref | broad.
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
const mode = process.env.ROUTER_FAKE_PLAN ?? 'valid';
const contract =
  mode === 'badref' ? { ...good, build_ref: 'nope' } : mode === 'broad' ? { ...good, allowed_globs: ['**'] } : good;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(contract) }) + '\n');
process.exit(0);
