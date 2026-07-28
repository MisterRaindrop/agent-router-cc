// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLauncher, codexLauncher } from '../src/app/codexLauncher.ts';

const CTX = {
  task: {
    schema_version: 1 as const,
    id: 'demo',
    title: 'demo',
    base_sha: null,
    max_wall_minutes: 1,
    allowed_globs: ['src/**'],
  },
  worktreeDir: '/tmp/router-worktree',
  contractMdText: '# Goal\nEdit src/a.ts.',
  planExists: false,
};

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

test('codex launcher passes model + reasoning effort', () => {
  const argv = codexLauncher({ model: 'gpt-5.6-sol', effort: 'max' }).buildArgv(CTX);
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.6-sol');
  assert.equal(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=max');
});

test('codex resume carries the same model + effort', () => {
  const argv = codexLauncher({ model: 'gpt-5.6-terra', effort: 'xhigh' }).buildResumeArgv(
    '/tmp/wt',
    'sess-1',
    'fix it',
  );
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.6-terra');
  assert.equal(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=xhigh');
});

test('claude launcher passes --model + --effort', () => {
  const argv = claudeLauncher({ model: 'opus', effort: 'xhigh' }).buildArgv(CTX);
  assert.equal(argv[argv.indexOf('--model') + 1], 'opus');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'xhigh');
});

test('no effort -> no effort flag (backward compatible)', () => {
  const codexArgv = codexLauncher({ model: 'gpt-5.6-terra' }).buildArgv(CTX);
  assert.ok(!codexArgv.includes('-c'));
  const claudeArgv = claudeLauncher({ model: 'haiku' }).buildArgv(CTX);
  assert.ok(!claudeArgv.includes('--effort'));
});
