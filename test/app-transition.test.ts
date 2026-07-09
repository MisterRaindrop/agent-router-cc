import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPaths } from '../src/io/paths.ts';
import { fixedClock } from '../src/io/clock.ts';
import * as store from '../src/io/store.ts';
import { foldEvents } from '../src/core/projectState.ts';
import { IllegalTransitionError } from '../src/core/stateMachine.ts';
import {
  createTask,
  currentState,
  NoSuchTaskError,
  transition,
  TaskExistsError,
} from '../src/app/transition.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'router-tx-'));
  const paths = routerPaths(join(dir, '.router'));
  const clock = fixedClock('2026-07-09T00:00:00.000Z');
  return { dir, deps: { paths, clock }, paths, clock };
}

test('createTask writes DRAFT; state.json equals fold(events)', () => {
  const { dir, deps, paths } = setup();
  try {
    const st = createTask(deps, 't1', 'Hello');
    assert.equal(st.state, 'DRAFT');
    assert.equal(st.title, 'Hello');
    assert.deepEqual(store.readState(paths, 't1'), foldEvents('t1', store.readEvents(paths, 't1')));
    assert.equal(store.readRegistry(paths)?.tasks['t1']?.state, 'DRAFT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTask is idempotent for a still-DRAFT task', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 't1', 'Hello');
    createTask(deps, 't1', 'Hello');
    assert.equal(store.readEvents(paths, 't1').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createTask throws if task advanced past DRAFT', () => {
  const { dir, deps } = setup();
  try {
    createTask(deps, 't1', 'Hello');
    transition(deps, 't1', 'VALIDATED', { actor: 'cli:validate' });
    assert.throws(() => createTask(deps, 't1', 'Hello'), TaskExistsError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legal transition sequence advances and records events', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 't1', 'Hello');
    transition(deps, 't1', 'VALIDATED', { actor: 'cli:validate', meta: { base_sha: 'a'.repeat(40), contract_hash: 'c'.repeat(64) } });
    transition(deps, 't1', 'QUEUED', { actor: 'cli:queue' });
    const st = transition(deps, 't1', 'RUNNING', { actor: 'cli:run', runId: 'run-001', meta: { attempt_number: 1 } });
    assert.equal(st.state, 'RUNNING');
    assert.equal(st.base_sha, 'a'.repeat(40));
    assert.equal(st.current_run, 'run-001');
    assert.equal(st.attempt_number, 1);
    const events = store.readEvents(paths, 't1');
    assert.deepEqual(events.map((e) => e.to), ['DRAFT', 'VALIDATED', 'QUEUED', 'RUNNING']);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('illegal transition throws and does NOT append an event', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 't1', 'Hello');
    assert.throws(() => transition(deps, 't1', 'MERGED', { actor: 'x' }), IllegalTransitionError);
    assert.equal(store.readEvents(paths, 't1').length, 1); // only DRAFT
    assert.equal(currentState(paths, 't1')?.state, 'DRAFT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transition on unknown task throws NoSuchTaskError', () => {
  const { dir, deps } = setup();
  try {
    assert.throws(() => transition(deps, 'ghost', 'VALIDATED', { actor: 'x' }), NoSuchTaskError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry entry tracks the latest state and run', () => {
  const { dir, deps, paths } = setup();
  try {
    createTask(deps, 't1', 'Hello');
    transition(deps, 't1', 'VALIDATED', { actor: 'v' });
    transition(deps, 't1', 'QUEUED', { actor: 'q' });
    transition(deps, 't1', 'RUNNING', { actor: 'r', runId: 'run-001', meta: { attempt_number: 1 } });
    const entry = store.readRegistry(paths)?.tasks['t1'];
    assert.equal(entry?.state, 'RUNNING');
    assert.equal(entry?.current_run, 'run-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
