// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStatusWriter, recentCodexAction } from '../src/app/runStatus.ts';
import type { RunStatus } from '../src/domain/types.ts';
import { fixedClock } from '../src/io/clock.ts';

function codexEvent(item: Record<string, unknown>): string {
  return JSON.stringify({ type: 'item.completed', item });
}

test('Codex command_execution extracts the real command through its login-shell wrapper', () => {
  const line = codexEvent({
    id: 'item_1',
    type: 'command_execution',
    command: `/bin/zsh -lc "sed -n '1,40p' src/app/dispatch.ts"`,
    aggregated_output: 'file contents must not be inspected',
    exit_code: 0,
    status: 'completed',
  });

  assert.equal(recentCodexAction(line), 'Bash: sed');
  assert.equal(
    recentCodexAction(
      codexEvent({ type: 'command_execution', command: `bash -lc 'git diff --stat src/app/runStatus.ts'` }),
    ),
    'Bash: git diff',
  );
  assert.equal(
    recentCodexAction(
      codexEvent({ type: 'command_execution', command: `sh -c "npm run check -- --secret value"` }),
    ),
    'Bash: npm run',
  );
});

test('Codex status persists only allowlisted tokens, never command arguments or secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-status-codex-'));
  const path = join(dir, 'status.json');
  const worktree = join(dir, 'worktree');
  // Named `planted`, not `secret`: a `secret = '<20+ chars with digits>'` line is exactly
  // what router's own secret gate flags, and this fixture would trip it on every diff.
  const planted = 'FAKE_CODEX_CREDENTIAL_987654';
  mkdirSync(worktree, { recursive: true });
  try {
    const status = new RunStatusWriter({
      path,
      workDir: worktree,
      budgetMinutes: 10,
      clock: fixedClock('2026-08-12T00:00:00.000Z'),
    });
    status.executorStarting(60_000);
    status.transition('executor_working', 60_000);
    status.noteOutput(
      codexEvent({
        type: 'command_execution',
        command: `/bin/zsh -lc "git status --porcelain --token ${planted}"`,
      }),
      'codex',
    );

    const raw = readFileSync(path, 'utf8');
    const written = JSON.parse(raw) as RunStatus;
    assert.equal(written.recent_action, 'Bash: git status');
    assert.doesNotMatch(raw, new RegExp(planted));
    assert.doesNotMatch(raw, /--porcelain|--token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex agent_message prose is ignored', () => {
  const planted = 'MODEL_PROSE_MUST_NOT_PERSIST';
  assert.equal(
    recentCodexAction(
      codexEvent({
        type: 'agent_message',
        text: `I will run git status and reveal ${planted}`,
      }),
    ),
    undefined,
  );
});

test('Codex command with an unparseable shell wrapper yields no action', () => {
  assert.equal(
    recentCodexAction(
      codexEvent({
        type: 'command_execution',
        command: `/bin/zsh -lc "git status --porcelain`,
      }),
    ),
    undefined,
  );
});
