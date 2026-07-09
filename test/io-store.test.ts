import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../src/io/jsonl.ts';
import * as store from '../src/io/store.ts';
import { routerPaths } from '../src/io/paths.ts';
import type { EventRecord, StateFile } from '../src/domain/types.ts';

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

test('appendJsonl rejects an embedded-newline invariant break', () => {
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

test('state read/write round-trips; missing => null', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    assert.equal(store.readState(p, 't1'), null);
    const s: StateFile = {
      schema_version: 1,
      id: 't1',
      state: 'DRAFT',
      base_sha: null,
      contract_hash: null,
      current_run: null,
      attempt_number: 0,
      title: 'hi',
      updated_at: '2026-07-09T00:00:00.000Z',
      last_event_seq: 1,
    };
    store.writeState(p, 't1', s);
    assert.deepEqual(store.readState(p, 't1'), s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events append + read', () => {
  const dir = tmp();
  try {
    const p = routerPaths(join(dir, '.router'));
    const e1: EventRecord = { seq: 1, ts: 't', from: null, to: 'DRAFT', actor: 'cli:new', run_id: null };
    const e2: EventRecord = { seq: 2, ts: 't', from: 'DRAFT', to: 'VALIDATED', actor: 'cli:validate', run_id: null };
    store.appendEvent(p, 't1', e1);
    store.appendEvent(p, 't1', e2);
    const got = store.readEvents(p, 't1');
    assert.equal(got.length, 2);
    assert.equal(got[1]!.to, 'VALIDATED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metrics append + read; listTaskIds / listRunIds sorted', () => {
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
    assert.equal(store.readMetrics(p).length, 1);

    // create task/run dirs by writing artifacts
    store.writeState(p, 'b-task', {
      schema_version: 1, id: 'b-task', state: 'DRAFT', base_sha: null, contract_hash: null,
      current_run: null, attempt_number: 0, title: '', updated_at: 't', last_event_seq: 0,
    });
    store.writeState(p, 'a-task', {
      schema_version: 1, id: 'a-task', state: 'DRAFT', base_sha: null, contract_hash: null,
      current_run: null, attempt_number: 0, title: '', updated_at: 't', last_event_seq: 0,
    });
    assert.deepEqual(store.listTaskIds(p), ['a-task', 'b-task']);

    store.writeLease(p, 'a-task', 'run-002', {
      run_id: 'run-002', task_id: 'a-task', attempt_number: 1, supervisor_pid: 1, worker_pgid: 1,
      host: 'h', started_at: 't', max_wall_minutes: 30, wall_deadline: 't', heartbeat_path: 'heartbeat',
    });
    store.writeLease(p, 'a-task', 'run-001', {
      run_id: 'run-001', task_id: 'a-task', attempt_number: 1, supervisor_pid: 1, worker_pgid: 1,
      host: 'h', started_at: 't', max_wall_minutes: 30, wall_deadline: 't', heartbeat_path: 'heartbeat',
    });
    assert.deepEqual(store.listRunIds(p, 'a-task'), ['run-001', 'run-002']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
