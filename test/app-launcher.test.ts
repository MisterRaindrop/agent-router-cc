// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLauncher } from '../src/app/codexLauncher.ts';

test('claude launcher uses worktree-scoped file tools without bypassPermissions', () => {
  const argv = claudeLauncher({ model: 'haiku' }).buildArgv({
    task: {
      schema_version: 1,
      id: 'demo',
      title: 'demo',
      base_sha: null,
      max_wall_minutes: 1,
      allowed_globs: ['src/**'],
    },
    worktreeDir: '/tmp/router-worktree',
    contractMdText: '# Goal\nEdit src/a.ts.',
    planExists: false,
  });
  assert.deepEqual(argv.slice(0, 2), ['claude', '-p']);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Edit,Write');
  assert.equal(argv[argv.indexOf('--add-dir') + 1], '/tmp/router-worktree');
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
  assert.ok(!argv.includes('bypassPermissions'));
});
