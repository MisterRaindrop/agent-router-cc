// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeLog, parseCodexLog, parseDeliveryHeader } from '../src/app/usage.ts';

test('parseCodexLog sums turn.completed usage across turns', () => {
  const log = [
    '{"type":"turn.started"}',
    'some non-json stderr line',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}',
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
  ].join('\n');
  assert.deepEqual(parseCodexLog(log).usage, { input: 150, output: 15, cached: 40 });
});

test('parseCodexLog returns null usage when none present', () => {
  assert.equal(parseCodexLog('no json here\n{"type":"turn.started"}\n').usage, null);
});

test('parseCodexLog picks up a model field when present, null otherwise', () => {
  assert.equal(parseCodexLog('{"type":"thread.started","model":"gpt-5.5"}\n').model, 'gpt-5.5');
  assert.equal(parseCodexLog('{"type":"turn.started","turn":{"model":"o3"}}\n').model, 'o3');
  // current real codex exec --json carries no model field:
  assert.equal(parseCodexLog('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.completed"}\n').model, null);
});

test('parseCodexLog returns usage and model in a single pass', () => {
  const log = '{"type":"thread.started","model":"gpt-5.5"}\n{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n';
  const r = parseCodexLog(log);
  assert.equal(r.model, 'gpt-5.5');
  assert.deepEqual(r.usage, { input: 10, output: 2, cached: 0 });
});

test('parseCodexLog returns the last completed agent message', () => {
  const log = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"command_execution","text":"ignored"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final delivery"}}',
  ].join('\n');
  assert.equal(parseCodexLog(log).finalMessage, 'final delivery');
});

test('parseCodexLog counts completed command executions', () => {
  const log = [
    '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
    '{"type":"item.started","item":{"type":"command_execution","command":"npm run check"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"npm run check"}}',
  ].join('\n');
  assert.equal(parseCodexLog(log).commandsRun, 2);
  assert.equal(parseCodexLog('{"type":"turn.completed"}').commandsRun, 0);
});

test('parseClaudeLog reads usage + total_cost_usd from the result event', () => {
  const log =
    '{"type":"assistant"}\n{"type":"result","subtype":"success","total_cost_usd":0.02,"usage":{"input_tokens":800,"output_tokens":60,"cache_read_input_tokens":100}}\n';
  const r = parseClaudeLog(log);
  // Input is the INCLUSIVE total (800 + 100), matching what codex already reports, so the two
  // executors' token counts mean the same thing when usage compares them.
  assert.deepEqual(r.usage, { input: 900, output: 60, cached: 100 });
  assert.equal(r.costUsd, 0.02);
});

// Claude splits input three ways and cache *creation* was being dropped entirely -- a run that
// had just read a repository reported 9 input tokens, which understates every token-derived
// saving attributed to a claude executor.
test('parseClaudeLog counts cache creation as input too', () => {
  const log =
    '{"type":"result","subtype":"success","usage":{"input_tokens":9,"output_tokens":760,' +
    '"cache_read_input_tokens":120000,"cache_creation_input_tokens":30000}}\n';
  const r = parseClaudeLog(log);
  assert.deepEqual(r.usage, { input: 150009, output: 760, cached: 120000 });
});

test('parseClaudeLog reads final assistant text from stream-json events', () => {
  const log = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"draft"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"final "},{"type":"text","text":"delivery"}]}}',
    '{"type":"result","result":"terminal delivery"}',
  ].join('\n');
  assert.equal(parseClaudeLog(log).finalMessage, 'terminal delivery');
});

test('parseDeliveryHeader accepts a valid block and ignores unknown keys', () => {
  const message = `Summary.
\`\`\`router-delivery
task: p0a
plan_revision: plan-2
gate_ran: true
scope_drift: false
escalate_review: true
future_key: ignored
\`\`\``;
  assert.deepEqual(parseDeliveryHeader(message), {
    task: 'p0a',
    plan_revision: 'plan-2',
    gate_ran: true,
    scope_drift: false,
    escalate_review: true,
  });
});

test('parseDeliveryHeader fails closed for absent, incomplete, or malformed blocks', () => {
  assert.equal(parseDeliveryHeader('no delivery block'), null);
  assert.equal(
    parseDeliveryHeader(`\`\`\`router-delivery
task: p0a
gate_ran: true
scope_drift: false
\`\`\``),
    null,
  );
  assert.equal(
    parseDeliveryHeader(`\`\`\`router-delivery
task: p0a
gate_ran: yes
scope_drift: false
escalate_review: false
\`\`\``),
    null,
  );
});

test('parseDeliveryHeader uses the last fenced block', () => {
  const message = `\`\`\`router-delivery
task: first
gate_ran: false
scope_drift: true
escalate_review: true
\`\`\`
text between
\`\`\`router-delivery
task: last
gate_ran: true
scope_drift: false
escalate_review: false
\`\`\``;
  assert.deepEqual(parseDeliveryHeader(message), {
    task: 'last',
    gate_ran: true,
    scope_drift: false,
    escalate_review: false,
  });
});
