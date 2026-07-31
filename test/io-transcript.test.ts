// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sumMainModelUsageSince } from '../src/io/transcript.ts';

const fixture = fileURLToPath(new URL('./fixtures/claude-session.jsonl', import.meta.url));

test('sumMainModelUsageSince filters transcript records and sums matching assistant turns', () => {
  assert.deepEqual(sumMainModelUsageSince(fixture, '2026-07-24T14:21:02.633Z', 'opus'), {
    inputTokens: 77,
    outputTokens: 14,
    turns: 4,
  });
});

test('sumMainModelUsageSince includes the until timestamp and excludes later turns', () => {
  assert.deepEqual(
    sumMainModelUsageSince(
      fixture,
      '2026-07-24T14:21:02.633Z',
      'claude-opus-4-8',
      '2026-07-24T14:24:00.000Z',
    ),
    {
      inputTokens: 37,
      outputTokens: 6,
      turns: 3,
    },
  );
});

test('sumMainModelUsageSince returns zero usage for a missing transcript', () => {
  assert.deepEqual(sumMainModelUsageSince(`${fixture}.missing`, '2026-07-24T14:21:02.633Z', 'opus'), {
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
});
