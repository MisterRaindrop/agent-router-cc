// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// The run dimension is folded: a run's files sit in `tasks/<id>/`, not `tasks/<id>/runs/run-001/`.
// That directory level was always over a constant -- dispatch has been one attempt per task
// since the synchronous model landed -- but records written before the fold still exist on disk,
// and an upgrade that made a task's history vanish would be worse than one extra lookup.
test('readResult finds a record written in the pre-fold runs/run-001 location', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    const legacy = p.legacyResultJson('old-task');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ task_id: 'old-task', exit_class: 'ok' }));
    assert.equal(store.readResult(p, 'old-task')?.exit_class, 'ok');

    // The current location wins when both exist: the legacy one is a fallback, not a merge.
    store.writeResult(p, 'old-task', { task_id: 'old-task', exit_class: 'task_failed' } as never);
    assert.equal(store.readResult(p, 'old-task')?.exit_class, 'task_failed');
    // ...and writing never touches the old path.
    assert.match(readFileSync(legacy, 'utf8'), /"exit_class":"ok"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeResult puts the record directly under tasks/<id>', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    store.writeResult(p, 't1', { task_id: 't1', exit_class: 'ok' } as never);
    assert.equal(p.resultJson('t1'), join(dir, '.router', 'tasks', 't1', 'result.json'));
    assert.doesNotMatch(p.resultJson('t1'), /runs/);
    assert.ok(existsSync(join(dir, '.router', 'tasks', 't1', 'result.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review finding 8. A pre-fold record has no `branch` field, and every consumer -- land, resume,
// the queue gate, list -- falls back to `router/<id>`. But that run's branch was actually
// `router/<id>/<run_id>`, so a task that was PASSED and waiting to be merged before the upgrade
// could not be merged after it. Read-only compatibility that cannot read the thing it exists for
// is not compatibility.
test('a legacy record gets its branch derived from run_id (finding 8)', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    const legacy = p.legacyResultJson('old-task');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({ task_id: 'old-task', run_id: 'run-001', exit_class: 'ok', verifier: { result: 'PASSED', checks: [] } }),
    );
    const got = store.readResult(p, 'old-task');
    assert.equal(got?.branch, 'router/old-task/run-001', 'the real pre-fold branch name');
    assert.equal(got?.exit_class, 'ok');

    // A current record is never rewritten -- its own branch wins.
    store.writeResult(p, 'new-task', { task_id: 'new-task', exit_class: 'ok', branch: 'router/new-task' } as never);
    assert.equal(store.readResult(p, 'new-task')?.branch, 'router/new-task');

    // A legacy record with no run_id at all is left alone rather than guessed at.
    const bare = p.legacyResultJson('bare');
    mkdirSync(dirname(bare), { recursive: true });
    writeFileSync(bare, JSON.stringify({ task_id: 'bare', exit_class: 'ok' }));
    assert.equal(store.readResult(p, 'bare')?.branch, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
