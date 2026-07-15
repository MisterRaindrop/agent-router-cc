// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexQuota, readClaudeQuota } from '../src/io/quota.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-quota-'));

// A realistic codex session line: rate_limits nested under a payload, primary=5h,
// secondary=weekly (the most-binding window should win).
const codexLine = JSON.stringify({
  type: 'token_count',
  payload: {
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 40, window_minutes: 300, resets_at: 1000 },
      secondary: { used_percent: 70, window_minutes: 10080, resets_at: 9000 },
      rate_limit_reached_type: null,
    },
  },
});

test('readCodexQuota parses the most-binding window from the newest session file', () => {
  const dir = tmp();
  try {
    const day = join(dir, '2026', '07', '13');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-07-13T10-00-00-x.jsonl'), '{"type":"other"}\n' + codexLine + '\n');
    const q = readCodexQuota(dir);
    assert.ok(q);
    assert.equal(q!.kind, 'codex');
    assert.equal(q!.used_percent, 70); // secondary (weekly) is more binding than primary
    assert.equal(q!.resets_at, 9000);
    assert.equal(q!.available, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCodexQuota picks the newest file and marks unavailable when a limit was reached', () => {
  const dir = tmp();
  try {
    const d1 = join(dir, '2026', '07', '12');
    const d2 = join(dir, '2026', '07', '14');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, 'rollout-2026-07-12T10-00-00-a.jsonl'), codexLine + '\n'); // older
    const hit = JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: 5000 }, rate_limit_reached_type: 'primary' } },
    });
    writeFileSync(join(d2, 'rollout-2026-07-14T10-00-00-b.jsonl'), hit + '\n'); // newer
    const q = readCodexQuota(dir);
    assert.ok(q);
    assert.equal(q!.used_percent, 100);
    assert.equal(q!.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readCodexQuota returns null when there is no session data', () => {
  const dir = tmp();
  try {
    assert.equal(readCodexQuota(dir), null);
    assert.equal(readCodexQuota(join(dir, 'nope')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readClaudeQuota reads the statusline snapshot; null when absent/invalid', () => {
  const dir = tmp();
  try {
    const p = join(dir, 'usage.json');
    assert.equal(readClaudeQuota(p), null); // missing
    writeFileSync(p, JSON.stringify({ used_percent: 25, resets_at: 4321, reached: false }));
    const q = readClaudeQuota(p);
    assert.ok(q);
    assert.equal(q!.kind, 'claude');
    assert.equal(q!.used_percent, 25);
    assert.equal(q!.resets_at, 4321);
    assert.equal(q!.available, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
