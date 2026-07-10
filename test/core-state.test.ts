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
import {
  isRescueAttempt,
  ladderTargetAfterFailure,
  resolveRescueWorker,
} from '../src/core/escalation.ts';
import type { EventRecord, Policy } from '../src/domain/types.ts';

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

test('escalation ladder transitions used by the auto-advance are legal', () => {
  // A run failing at each rung advances FROM FAILED to the next rung.
  assert.ok(canTransition('FAILED', 'ESCALATED_1'));
  assert.ok(canTransition('FAILED', 'ESCALATED_2'));
  assert.ok(canTransition('FAILED', 'NEEDS_REPLAN'));
  // A rung can start a new attempt (-> RUNNING).
  assert.ok(canTransition('ESCALATED_1', 'RUNNING'));
  assert.ok(canTransition('ESCALATED_2', 'RUNNING'));
  // NEEDS_REPLAN is terminal-ish: no auto-retry, only human replan back to DRAFT.
  assert.equal(canTransition('NEEDS_REPLAN', 'RUNNING'), false);
  assert.equal(canTransition('NEEDS_REPLAN', 'QUEUED'), false);
});

test('ladderTargetAfterFailure: opt-in via max_attempts', () => {
  // Escalation off: unset or < 2 -> stay FAILED (null).
  assert.equal(
    ladderTargetAfterFailure({ attemptNumber: 1, maxAttempts: undefined, countsAsAttempt: true }),
    null,
  );
  assert.equal(
    ladderTargetAfterFailure({ attemptNumber: 1, maxAttempts: 1, countsAsAttempt: true }),
    null,
  );
});

test('ladderTargetAfterFailure: env/quota (non-counting) never advances', () => {
  assert.equal(
    ladderTargetAfterFailure({ attemptNumber: 1, maxAttempts: 3, countsAsAttempt: false }),
    null,
  );
});

test('ladderTargetAfterFailure: climbs retry -> rescue -> replan', () => {
  const m = 3;
  assert.equal(ladderTargetAfterFailure({ attemptNumber: 1, maxAttempts: m, countsAsAttempt: true }), 'ESCALATED_1');
  assert.equal(ladderTargetAfterFailure({ attemptNumber: 2, maxAttempts: m, countsAsAttempt: true }), 'ESCALATED_2');
  assert.equal(ladderTargetAfterFailure({ attemptNumber: 3, maxAttempts: m, countsAsAttempt: true }), 'NEEDS_REPLAN');
  // With max_attempts=2, the second failure exhausts attempts -> NEEDS_REPLAN.
  assert.equal(ladderTargetAfterFailure({ attemptNumber: 1, maxAttempts: 2, countsAsAttempt: true }), 'ESCALATED_1');
  assert.equal(ladderTargetAfterFailure({ attemptNumber: 2, maxAttempts: 2, countsAsAttempt: true }), 'NEEDS_REPLAN');
});

test('isRescueAttempt only for a run started from ESCALATED_2', () => {
  assert.equal(isRescueAttempt('ESCALATED_2'), true);
  assert.equal(isRescueAttempt('ESCALATED_1'), false);
  assert.equal(isRescueAttempt('QUEUED'), false);
  assert.equal(isRescueAttempt(null), false);
});

test('resolveRescueWorker: explicit wins, else last of chain', () => {
  const base = { schema_version: 1 as const, scope: { max_changed_lines: 1 }, verification: { build: [['x']] } };
  // explicit rescue_worker
  const withRescue: Policy = {
    ...base,
    workers: [{ kind: 'codex' }, { kind: 'claude' }],
    escalation: { max_attempts: 3, rescue_worker: { kind: 'claude', model: 'strong' } },
  };
  assert.deepEqual(resolveRescueWorker(withRescue), { kind: 'claude', model: 'strong' });
  // no explicit -> last of the workers chain
  const chain: Policy = { ...base, workers: [{ kind: 'codex' }, { kind: 'claude' }], escalation: { max_attempts: 3 } };
  assert.deepEqual(resolveRescueWorker(chain), { kind: 'claude' });
  // single `worker` (back-compat) -> that worker
  const single: Policy = { ...base, worker: { kind: 'codex', model: 'm' } };
  assert.deepEqual(resolveRescueWorker(single), { kind: 'codex', model: 'm' });
  // nothing configured -> undefined
  assert.equal(resolveRescueWorker(base as Policy), undefined);
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
