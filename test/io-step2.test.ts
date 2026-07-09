import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../src/io/atomicWrite.ts';
import { routerPaths, runId, runBranch, findRouterDir } from '../src/io/paths.ts';
import { fixedClock, systemClock } from '../src/io/clock.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'router-step2-'));
}

test('writeFileAtomic writes exact content and leaves no temp file', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'a.txt');
    writeFileAtomic(f, 'hello');
    assert.equal(readFileSync(f, 'utf8'), 'hello');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith('.tmp.')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic creates missing parent directories', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'nested', 'deep', 'b.txt');
    writeFileAtomic(f, 'x');
    assert.equal(readFileSync(f, 'utf8'), 'x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic overwrite replaces content atomically (no leftover tmp)', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'c.txt');
    writeFileAtomic(f, 'first-version');
    writeFileAtomic(f, 'second');
    assert.equal(readFileSync(f, 'utf8'), 'second');
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith('.tmp.')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('many sequential writes never yield a torn file', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'd.txt');
    const payloads = Array.from({ length: 50 }, (_, i) => `payload-${i}-${'x'.repeat(i)}`);
    for (const p of payloads) {
      writeFileAtomic(f, p);
      const got = readFileSync(f, 'utf8');
      assert.ok(payloads.includes(got), `torn/unknown content: ${got}`);
    }
    assert.equal(readFileSync(f, 'utf8'), payloads[payloads.length - 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic round-trips with trailing newline', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'e.json');
    writeJsonAtomic(f, { a: 1, b: [2, 3] });
    const raw = readFileSync(f, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(JSON.parse(raw), { a: 1, b: [2, 3] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runId zero-pads; runBranch composes', () => {
  assert.equal(runId(1), 'run-001');
  assert.equal(runId(42), 'run-042');
  assert.equal(runId(1000), 'run-1000');
  assert.equal(runBranch('my-task', runId(2)), 'router/my-task/run-002');
});

test('routerPaths composes the full .router layout', () => {
  const p = routerPaths('/proj/.router');
  assert.equal(p.policy, '/proj/.router/policy.yaml');
  assert.equal(p.registry, '/proj/.router/registry.json');
  assert.equal(p.lockDir, '/proj/.router/.lock');
  assert.equal(p.stateFile('t1'), '/proj/.router/tasks/t1/state.json');
  assert.equal(p.eventsFile('t1'), '/proj/.router/tasks/t1/events.jsonl');
  assert.equal(p.lease('t1', 'run-001'), '/proj/.router/tasks/t1/runs/run-001/lease.json');
  assert.equal(p.workerLog('t1', 'run-001'), '/proj/.router/tasks/t1/runs/run-001/logs/worker.log');
  assert.equal(p.worktree('t1', 'run-001'), '/proj/.router/worktrees/t1/run-001');
});

test('findRouterDir walks up to the nearest .router', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.router'));
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    assert.equal(findRouterDir(join(dir, 'a', 'b')), join(dir, '.router'));
    assert.equal(findRouterDir(dir), join(dir, '.router'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findRouterDir returns null when absent', () => {
  const dir = tmp();
  try {
    assert.equal(findRouterDir(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixedClock advances only on demand; systemClock produces ISO', () => {
  const c = fixedClock('2026-07-09T00:00:00.000Z', 1000);
  assert.equal(c.nowIso(), '2026-07-09T00:00:00.000Z');
  assert.equal(c.monotonicMs(), 1000);
  c.advanceMs(500);
  assert.equal(c.monotonicMs(), 1500);
  c.set('2026-07-09T01:00:00.000Z');
  assert.equal(c.nowIso(), '2026-07-09T01:00:00.000Z');
  assert.match(systemClock.nowIso(), /^\d{4}-\d{2}-\d{2}T/);
});
