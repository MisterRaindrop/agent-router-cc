// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isTerminal,
  nextStates,
} from '../src/core/stateMachine.ts';
import { CorruptEventLogError, foldEvents } from '../src/core/projectState.ts';
import type { EventRecord } from '../src/domain/types.ts';

test('happy-path transitions are legal', () => {
  const path = ['DRAFT', 'VALIDATED', 'QUEUED', 'RUNNING', 'VERIFYING', 'PASSED', 'MERGED'] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`);
  }
});

test('illegal skips are rejected', () => {
  assert.equal(canTransition('DRAFT', 'RUNNING'), false);
  assert.equal(canTransition('QUEUED', 'PASSED'), false);
  assert.equal(canTransition('PASSED', 'RUNNING'), false);
  assert.equal(canTransition('DRAFT', 'MERGED'), false);
});

test('CANCELLED/ABANDONED reachable from any non-terminal state', () => {
  for (const s of ['DRAFT', 'VALIDATED', 'QUEUED', 'RUNNING', 'VERIFYING', 'PASSED', 'FAILED'] as const) {
    assert.ok(canTransition(s, 'CANCELLED'), `${s} -> CANCELLED`);
    assert.ok(canTransition(s, 'ABANDONED'), `${s} -> ABANDONED`);
  }
});

test('terminal states allow nothing', () => {
  for (const s of ['MERGED', 'CANCELLED', 'ABANDONED'] as const) {
    assert.ok(isTerminal(s));
    assert.deepEqual(nextStates(s), []);
  }
});

test('escalation ladder exists in the graph (M2 seam)', () => {
  assert.ok(canTransition('FAILED', 'ESCALATED_1'));
  assert.ok(canTransition('ESCALATED_1', 'ESCALATED_2'));
  assert.ok(canTransition('ESCALATED_2', 'RUNNING'));
  assert.ok(canTransition('ESCALATED_1', 'NEEDS_REPLAN'));
  assert.ok(canTransition('NEEDS_REPLAN', 'DRAFT'));
});

test('assertTransition throws IllegalTransitionError', () => {
  assert.throws(() => assertTransition('DRAFT', 'MERGED'), IllegalTransitionError);
});

// -- foldEvents --
const ev = (seq: number, from: EventRecord['from'], to: EventRecord['to'], meta?: Record<string, unknown>, run_id: string | null = null): EventRecord => ({
  seq,
  ts: `2026-07-09T00:00:0${seq}.000Z`,
  from,
  to,
  actor: 'test',
  run_id,
  ...(meta ? { meta } : {}),
});

test('foldEvents reconstructs the full StateFile', () => {
  const events: EventRecord[] = [
    ev(1, null, 'DRAFT', { title: 'My Task' }),
    ev(2, 'DRAFT', 'VALIDATED', { base_sha: 'a'.repeat(40), contract_hash: 'b'.repeat(64) }),
    ev(3, 'VALIDATED', 'QUEUED'),
    ev(4, 'QUEUED', 'RUNNING', { attempt_number: 1 }, 'run-001'),
  ];
  const st = foldEvents('t1', events);
  assert.equal(st.state, 'RUNNING');
  assert.equal(st.title, 'My Task');
  assert.equal(st.base_sha, 'a'.repeat(40));
  assert.equal(st.contract_hash, 'b'.repeat(64));
  assert.equal(st.current_run, 'run-001');
  assert.equal(st.attempt_number, 1);
  assert.equal(st.last_event_seq, 4);
  assert.equal(st.updated_at, '2026-07-09T00:00:04.000Z');
});

test('foldEvents rejects a seq gap (tamper)', () => {
  assert.throws(
    () => foldEvents('t1', [ev(1, null, 'DRAFT'), ev(3, 'DRAFT', 'VALIDATED')]),
    CorruptEventLogError,
  );
});

test('foldEvents rejects a wrong `from` (tamper)', () => {
  assert.throws(
    () => foldEvents('t1', [ev(1, null, 'DRAFT'), ev(2, 'QUEUED', 'RUNNING')]),
    CorruptEventLogError,
  );
});

test('foldEvents rejects an illegal transition (tamper)', () => {
  assert.throws(
    () => foldEvents('t1', [ev(1, null, 'DRAFT'), ev(2, 'DRAFT', 'MERGED')]),
    CorruptEventLogError,
  );
});

test('foldEvents rejects a bad first event', () => {
  assert.throws(() => foldEvents('t1', [ev(1, 'DRAFT', 'VALIDATED')]), CorruptEventLogError);
  assert.throws(() => foldEvents('t1', [ev(1, null, 'RUNNING')]), CorruptEventLogError);
});

test('foldEvents throws on empty log', () => {
  assert.throws(() => foldEvents('t1', []), CorruptEventLogError);
});
