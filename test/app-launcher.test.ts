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
  assert.ok(!argv.includes('--allowedTools'));
  assert.deepEqual(argv, [
    'claude',
    '-p',
    argv[2],
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--strict-mcp-config',
    '--tools',
    'Read,Edit,Write',
    '--add-dir',
    '/tmp/router-worktree',
    '--model',
    'haiku',
  ]);
});

// Measured, not assumed: without this flag a headless run inherits every MCP server from
// the user's own session, so a sandboxed executor gets tools far outside its task. Both the
// fresh-run and the resume invocation need it.
test('claude launcher never inherits the user MCP servers', () => {
  assert.ok(claudeLauncher({ model: 'sonnet' }).buildArgv(CTX).includes('--strict-mcp-config'));
  assert.ok(
    claudeLauncher({ model: 'sonnet' })
      .buildResumeArgv('/tmp/router-worktree', 'sess-1', 'fix it')
      .includes('--strict-mcp-config'),
  );
});

test('claude launcher narrowly pre-approves each declared verify command', () => {
  const argv = claudeLauncher({ model: 'sonnet' }).buildArgv({
    ...CTX,
    task: {
      ...CTX.task,
      verify: [
        ['npm', 'run', 'check'],
        ['node', '--test', 'test/unit.test.ts'],
      ],
    },
  });
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
  const allowedTools = argv.indexOf('--allowedTools');
  assert.deepEqual(argv.slice(allowedTools + 1, allowedTools + 3), [
    'Bash(npm run check)',
    'Bash(node --test test/unit.test.ts)',
  ]);
  // What this buys is measured: pre-approval removes the prompt for the gate. It does NOT
  // confine Bash to these commands -- a real sonnet run also executed `git diff` unprompted --
  // so the containment is the worktree cwd and the stripped environment, not this list.
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
  // Several `-c` overrides now ride along, so look through all of them.
  const overrides = argv.filter((token, i) => argv[i - 1] === '-c');
  assert.ok(overrides.includes('model_reasoning_effort=xhigh'), overrides.join(' '));
  // Measured against the real CLI: `codex exec resume` REJECTS `-C` ("unexpected argument")
  // and has no `-s`, so this path never worked while only the fakes exercised it. The cwd
  // comes from the spawn, and the sandbox is expressed as a config override instead.
  assert.ok(!argv.includes('-C'), 'exec resume does not accept -C');
  assert.ok(!argv.includes('-s'), 'exec resume does not accept -s');
  assert.ok(overrides.includes('sandbox_mode=workspace-write'), overrides.join(' '));
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
