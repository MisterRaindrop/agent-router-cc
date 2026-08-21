// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLauncher, codexLauncher } from '../src/app/codexLauncher.ts';

// Spelled out here rather than imported: the point of these assertions is that the grant list
// is exactly this and nothing wider, which an import from the module under test cannot prove.
const GIT_GRANTS = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git rev-parse:*)',
] as const;

const CTX = {
  task: {
    schema_version: 1 as const,
    id: 'demo',
    title: 'demo',
    base_sha: null,
    max_wall_minutes: 1,
    allowed_globs: ['src/**'],
  },
  workDir: '/tmp/router-worktree',
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
    workDir: '/tmp/router-worktree',
    contractMdText: '# Goal\nEdit src/a.ts.',
    planExists: false,
  });
  assert.deepEqual(argv.slice(0, 2), ['claude', '-p']);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  // Bash and the git allowlist are unconditional: a task with no verify command still has to
  // commit one commit per functional unit. PROBE-1 measured what happens without the grant --
  // the run wrote its file, was refused on `git add`/`git commit`, and stalled asking.
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
  assert.equal(argv[argv.indexOf('--add-dir') + 1], '/tmp/router-worktree');
  assert.equal(argv[argv.indexOf('--model') + 1], 'haiku');
  assert.ok(!argv.includes('bypassPermissions'));
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
    'Read,Edit,Write,Bash',
    '--add-dir',
    '/tmp/router-worktree',
    '--allowedTools',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git rev-parse:*)',
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
  // Also grant the program+subcommand prefix. Measured: with only the exact string, a real
  // sonnet run read files freely (`acceptEdits` auto-approves read-only Bash) but was blocked
  // reaching for `npm run typecheck` -- a sub-step of its own gate -- and stalled asking a
  // human who, headless, was not there. Reading is open; doing is confined to this list.
  const grants = argv.slice(allowedTools + 1, argv.indexOf('--model'));
  assert.deepEqual(grants, [
    'Bash(npm run check)',
    'Bash(npm run:*)',
    'Bash(node --test test/unit.test.ts)',
    'Bash(node --test:*)',
    'Bash(git add:*)',
    'Bash(git commit:*)',
    'Bash(git status:*)',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git rev-parse:*)',
  ]);
  assert.ok(!argv.includes('bypassPermissions'));
});

// The git grant is a subcommand allowlist, never `Bash(git:*)`: the contract's Must NOT forbids
// the executor moving between branches or rewriting history, and a blanket git grant would hand
// it exactly that. Guarding it in a test because the safe and the unsafe form differ by one word.
test('the executor git grant cannot reach checkout, reset, rebase, branch deletion or push', () => {
  for (const argv of [
    claudeLauncher({ model: 'haiku' }).buildArgv(CTX),
    claudeLauncher({ model: 'haiku' }).buildArgv({
      ...CTX,
      task: { ...CTX.task, verify: [['npm', 'run', 'check']] },
    }),
  ]) {
    const grants = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--model'));
    assert.ok(grants.includes('Bash(git commit:*)'));
    assert.ok(!grants.includes('Bash(git:*)'));
    for (const forbidden of ['checkout', 'reset', 'rebase', 'branch', 'push', 'stash', 'clean']) {
      assert.ok(
        !grants.some((g) => g.includes(`git ${forbidden}`)),
        `git ${forbidden} must not be pre-approved, saw: ${grants.join(' ')}`,
      );
    }
  }
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

// A resume is almost always "the gate failed, fix it", so the resumed run has to keep the same
// permission to run that gate. It did not: the resume argv hard-coded Read/Edit/Write and never
// received the task, so the executor was asked to fix a failure it was no longer allowed to
// reproduce.
test('a resumed claude run keeps permission to run the gate it is being asked to fix', () => {
  const withGate = claudeLauncher({ model: 'sonnet' }).buildResumeArgv('/wt', 'sess-1', 'fix it', {
    ...CTX.task,
    verify: [['npm', 'run', 'check']],
  });
  assert.equal(withGate[withGate.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
  const grants = withGate.slice(withGate.indexOf('--allowedTools') + 1, withGate.indexOf('--model'));
  assert.deepEqual(grants, ['Bash(npm run check)', 'Bash(npm run:*)', ...GIT_GRANTS]);

  // No gate declared, or no task at all: still Bash, still the git allowlist. A resume that
  // could not commit would strand the fix it was resumed to make.
  const noGate = claudeLauncher({ model: 'sonnet' }).buildResumeArgv('/wt', 'sess-1', 'fix it', {
    ...CTX.task,
    verify: [],
  });
  assert.equal(noGate[noGate.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
  assert.deepEqual(
    noGate.slice(noGate.indexOf('--allowedTools') + 1, noGate.indexOf('--model')),
    [...GIT_GRANTS],
  );
  const noTask = claudeLauncher({ model: 'sonnet' }).buildResumeArgv('/wt', 'sess-1', 'fix it');
  assert.equal(noTask[noTask.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
  assert.deepEqual(
    noTask.slice(noTask.indexOf('--allowedTools') + 1, noTask.indexOf('--model')),
    [...GIT_GRANTS],
  );
});
