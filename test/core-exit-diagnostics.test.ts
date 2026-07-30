// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for classifying on relayed log content. A real run exposed this: the
// executor ran this project's own test suite, so the log carried the words "quota" and
// "unknown model" as command output, and the run was reported as a stale model config --
// while a genuine failure would have been reclassified as a provider quota hit, silently
// switching executors and not counting as an attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectModelMismatch,
  executorDiagnostics,
  reclassifyEnvironmentFailure,
  reclassifyQuota,
} from '../src/core/exitTaxonomy.ts';

/** A codex-shaped log line relaying a command's output back to us. */
function relayedCommand(output: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: 'npm run check', exit_code: 0, aggregated_output: output },
  });
}

test('executorDiagnostics keeps the executor own lines and drops relayed content', () => {
  const log = [
    'Reading additional input from stdin...', // raw line
    JSON.stringify({ type: 'thread.started', model: 'm', thread_id: 's1' }),
    relayedCommand('✔ detects an unknown model message\nℹ quota tests pass'),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I hit a rate limit maybe' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no api key found' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'usage limit' }] } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
  ].join('\n');

  const kept = executorDiagnostics(log);
  assert.match(kept, /Reading additional input/);
  assert.match(kept, /thread.started/);
  assert.match(kept, /turn.completed/);
  assert.doesNotMatch(kept, /unknown model/);
  assert.doesNotMatch(kept, /quota/);
  assert.doesNotMatch(kept, /rate limit/);
  assert.doesNotMatch(kept, /no api key found/);
  assert.doesNotMatch(kept, /usage limit/);
});

test('a line that only looks like JSON is kept as raw text', () => {
  const kept = executorDiagnostics('{not really json at all');
  assert.equal(kept, '{not really json at all');
});

test('relayed output mentioning quota does NOT reclassify a plain failure', () => {
  const log = [relayedCommand('ℹ tests 201\nℹ pass 201\n429 appears in a fixture name, and quota too')].join('\n');
  assert.equal(reclassifyQuota('task_failed', log), 'task_failed');
});

test('relayed output mentioning an auth error does NOT reclassify a plain failure', () => {
  const log = relayedCommand("✔ treats 'not logged in' as an env error (0.4ms)");
  assert.equal(reclassifyEnvironmentFailure('task_failed', log), 'task_failed');
});

test('relayed output mentioning an unknown model does NOT flag a stale model config', () => {
  const log = relayedCommand('✔ parseCodexLog returns the model field when present, null otherwise\n✔ unknown model');
  assert.equal(detectModelMismatch(log), false);
});

test('a genuine provider failure on a raw line is still classified', () => {
  // Observed shape: codex prints the API error envelope outside its JSONL stream.
  assert.equal(reclassifyQuota('task_failed', 'ERROR: 429 rate limit exceeded'), 'quota_exhausted');
  assert.equal(reclassifyEnvironmentFailure('worker_crash', 'stream error: not logged in'), 'env_error');
  assert.equal(detectModelMismatch('ERROR: {"error":{"message":"Invalid model: unsupported model"}}'), true);
  assert.equal(detectModelMismatch('ERROR: the model gpt-9-omega is not available on your plan'), true);
});

test('the model-not-available pattern no longer spans unrelated text', () => {
  // The gap between "model" and "not available" is bounded, so a long unrelated stretch
  // between the two words cannot match the way an unbounded `.*` did.
  const far = `ERROR: model ${'x'.repeat(200)} is not available`;
  assert.equal(detectModelMismatch(far), false);
  assert.equal(detectModelMismatch('ERROR: model gpt-9 is not available'), true);
});
