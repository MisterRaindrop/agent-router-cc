// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../src/io/jsonl.ts';
import * as store from '../src/io/store.ts';
import { routerPaths } from '../src/io/paths.ts';
import type { MetricRecord } from '../src/domain/types.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-store-'));

test('appendJsonl preserves order; readJsonl round-trips', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'log.jsonl');
    for (let i = 0; i < 5; i++) appendJsonl(f, { seq: i, v: `x${i}` });
    const got = readJsonl<{ seq: number; v: string }>(f);
    assert.deepEqual(
      got.map((r) => r.seq),
      [0, 1, 2, 3, 4],
    );
    assert.equal(got[2]!.v, 'x2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonl returns [] for a missing file', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readJsonl(join(dir, 'nope.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonl drops a torn trailing line', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'log.jsonl');
    appendJsonl(f, { a: 1 });
    appendFileSync(f, '{"a":2,"partial'); // simulate interrupted append
    const got = readJsonl<{ a: number }>(f);
    assert.deepEqual(got, [{ a: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendJsonl escapes embedded newlines and round-trips', () => {
  const dir = tmp();
  try {
    // JSON.stringify escapes \n inside strings, so this must NOT throw and must round-trip.
    const f = join(dir, 'log.jsonl');
    appendJsonl(f, { s: 'line1\nline2' });
    const got = readJsonl<{ s: string }>(f);
    assert.equal(got[0]!.s, 'line1\nline2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendMetric writes one JSONL record to metrics.jsonl', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    store.appendMetric(p, {
      ts: 't',
      task_id: 't1',
      run_id: 'run-001',
      attempt_number: 1,
      model: 'codex-test',
      exit_class: 'ok',
      verifier_result: 'PASSED',
      first_pass: true,
      tokens_input: 1,
      tokens_output: 2,
      cost_usd: 0.1,
      wall_seconds: 3,
      escalated: false,
      env_error: false,
    });
    const got = readJsonl<MetricRecord>(p.metrics);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.task_id, 't1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
