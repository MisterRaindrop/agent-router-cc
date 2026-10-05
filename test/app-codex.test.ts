// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexResumeArgv, codexWriteArgv, parseCodexLog } from '../src/app/codex.ts';

test('a fresh write runs in the checkout under workspace-write and pins model and effort', () => {
  const argv = codexWriteArgv('do it', '/repo', { model: 'gpt-5.6-sol', effort: 'xhigh' });
  assert.deepEqual(argv.slice(1, 3), ['exec', 'do it']);
  assert.deepEqual(argv.slice(argv.indexOf('-C'), argv.indexOf('-C') + 2), ['-C', '/repo']);
  assert.deepEqual(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 2), ['-s', 'workspace-write']);
  assert.ok(argv.includes('--json'));
  assert.deepEqual(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2), ['-m', 'gpt-5.6-sol']);
  assert.ok(argv.includes('model_reasoning_effort=xhigh'));
});

// A real run proved `codex exec resume` rejects `-C` and has no `-s`; the fakes accepted both.
test('a resume carries neither -C nor -s, and expresses the sandbox as a config override', () => {
  const argv = codexResumeArgv('sess-1', 'fix it', { model: 'gpt-5.6-sol' });
  assert.deepEqual(argv.slice(1, 5), ['exec', 'resume', 'sess-1', 'fix it']);
  assert.equal(argv.includes('-C'), false);
  assert.equal(argv.includes('-s'), false);
  assert.ok(argv.includes('sandbox_mode=workspace-write'));
});

test('parseCodexLog reads the session, the model and the last agent message', () => {
  const log = [
    'not json',
    JSON.stringify({ type: 'thread.started', thread_id: 'sess-9', model: 'gpt-5.6-sol' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done: changed a.ts' } }),
  ].join('\n');
  assert.deepEqual(parseCodexLog(log), { model: 'gpt-5.6-sol', sessionId: 'sess-9', finalMessage: 'done: changed a.ts' });
  assert.deepEqual(parseCodexLog(''), { model: null, sessionId: null });
});
