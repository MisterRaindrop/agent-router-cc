import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd, parseCodexModel, parseCodexUsage } from '../src/app/usage.ts';

test('parseCodexUsage sums turn.completed usage across turns', () => {
  const log = [
    '{"type":"turn.started"}',
    'some non-json stderr line',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}',
    '{"type":"item.completed"}',
    '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":5}}',
  ].join('\n');
  const u = parseCodexUsage(log);
  assert.deepEqual(u, { input: 150, output: 15, cached: 40 });
});

test('parseCodexUsage returns null when no usage present', () => {
  assert.equal(parseCodexUsage('no json here\n{"type":"turn.started"}\n'), null);
});

test('parseCodexModel picks up a model field when present, null otherwise', () => {
  assert.equal(parseCodexModel('{"type":"thread.started","model":"gpt-5.5"}\n'), 'gpt-5.5');
  assert.equal(parseCodexModel('{"type":"turn.started","turn":{"model":"o3"}}\n'), 'o3');
  // current real codex exec --json carries no model field:
  assert.equal(parseCodexModel('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.completed"}\n'), null);
});

test('estimateCostUsd is null without configured prices, computed with them', () => {
  const u = { input: 1_000_000, output: 500_000, cached: 0 };
  assert.equal(estimateCostUsd(u, {}), null);
  const cost = estimateCostUsd(u, {
    ROUTER_PRICE_INPUT_PER_MTOK: '2',
    ROUTER_PRICE_OUTPUT_PER_MTOK: '8',
  } as NodeJS.ProcessEnv);
  assert.equal(cost, 2 * 1 + 8 * 0.5); // 2 + 4 = 6
});
