// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli/args.ts';

test('supervise preserves every command argument after the double-dash boundary', () => {
  const parsed = parseArgs([
    'supervise',
    '--label',
    'review:architect',
    '--log=review.log',
    '--',
    'codex',
    'exec',
    '--json',
    '--model=gpt-5.6-sol',
    'a brief with spaces',
  ]);

  assert.equal(parsed.verb, 'supervise');
  assert.deepEqual(parsed.flags, { label: 'review:architect', log: 'review.log' });
  assert.deepEqual(parsed.passthrough, [
    'codex',
    'exec',
    '--json',
    '--model=gpt-5.6-sol',
    'a brief with spaces',
  ]);
  assert.deepEqual(parsed.positionals, parsed.passthrough);
});
