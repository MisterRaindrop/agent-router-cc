// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { RunStatus } from '../src/domain/types.ts';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

function writeTask(dir: string, id: string, title: string): void {
  const taskDir = join(dir, '.router', 'tasks', id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.yaml'), `id: ${id}\ntitle: ${title}\n`);
}

function runDir(dir: string, id: string): string {
  const p = join(dir, '.router', 'tasks', id);
  mkdirSync(p, { recursive: true });
  return p;
}

function writeResult(dir: string, id: string, extra: Record<string, unknown>): void {
  writeFileSync(
    join(runDir(dir, id), 'result.json'),
    JSON.stringify({ task_id: id, exit_class: 'completed', ...extra }),
  );
}

/** Raw text so a malformed document can be planted verbatim. */
function writeStatusText(dir: string, id: string, text: string): void {
  writeFileSync(join(runDir(dir, id), 'status.json'), text);
}

function liveStatus(minutesAgo: number, extra: Partial<RunStatus> = {}): RunStatus {
  const started = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    phase: 'executor_working',
    started_at: started,
    phase_started_at: started,
    budget_minutes: 30,
    last_output_at: null,
    stall_deadline: null,
    ...extra,
  };
}

function writeStatus(dir: string, id: string, status: RunStatus): RunStatus {
  writeStatusText(dir, id, JSON.stringify(status));
  return status;
}

function jsonRows(dir: string): Record<string, unknown>[] {
  const json = router(dir, ['list', '--json']);
  assert.equal(json.code, 0, json.out);
  return (JSON.parse(json.out) as { tasks: Record<string, unknown>[] }).tasks;
}

test('list shows the live phase with elapsed minutes for a run still in flight', () => {
  const dir = fx.initRepo();
  try {
    writeTask(dir, 'running', 'Still going');
    const status = writeStatus(dir, 'running', liveStatus(3.5));

    const before = readdirSync(runDir(dir, 'running')).sort();
    const beforeStatus = readFileSync(join(runDir(dir, 'running'), 'status.json'), 'utf8');
    const beforeMtime = statSync(join(runDir(dir, 'running'), 'status.json')).mtimeMs;

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /running\s+executor_working 3m\s+-\s+-\s+-\s+Still going/);

    // `list` is a reporter: it must not touch the run it is reporting on.
    assert.deepEqual(readdirSync(runDir(dir, 'running')).sort(), before);
    assert.equal(readFileSync(join(runDir(dir, 'running'), 'status.json'), 'utf8'), beforeStatus);
    assert.equal(statSync(join(runDir(dir, 'running'), 'status.json')).mtimeMs, beforeMtime);

    const rows = jsonRows(dir);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      id: 'running',
      title: 'Still going',
      status: 'executor_working 3m',
      branch: null,
      risk: '-',
      report: '-',
      live: status,
    });
  } finally {
    fx.cleanup(dir);
  }
});

test('a queued run reports 0m and every phase renders as itself', () => {
  const dir = fx.initRepo();
  try {
    writeTask(dir, 'queued-now', 'Just queued');
    writeStatus(dir, 'queued-now', liveStatus(0, { phase: 'queued' }));
    writeTask(dir, 'verifying', 'Verifying');
    writeStatus(dir, 'verifying', liveStatus(75, { phase: 'verify' }));

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /queued-now\s+queued 0m\s+-/);
    assert.match(text.out, /verifying\s+verify 75m\s+-/);
  } finally {
    fx.cleanup(dir);
  }
});

test('a terminal status without result.json shows the terminal state, and result.json still wins', () => {
  const dir = fx.initRepo();
  try {
    writeTask(dir, 'stalled-run', 'Terminal, no result');
    writeStatus(dir, 'stalled-run', liveStatus(9, { phase: 'executor_working', terminal_state: 'stalled' }));

    writeTask(dir, 'finished', 'Result wins');
    const finishedStatus = writeStatus(dir, 'finished', liveStatus(9, { phase: 'verify', terminal_state: 'succeeded' }));
    writeResult(dir, 'finished', { verifier: { result: 'PASSED' }, risk: 'low' });

    writeTask(dir, 'live-but-done', 'Result wins over an in-flight status');
    writeStatus(dir, 'live-but-done', liveStatus(9));
    writeResult(dir, 'live-but-done', {});

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /stalled-run\s+stalled\s+-\s+-\s+-\s+Terminal, no result/);
    assert.match(text.out, /finished\s+PASSED\s+-\s+low\s+-\s+Result wins/);
    assert.match(text.out, /live-but-done\s+completed\s+-\s+-\s+-\s+Result wins over/);

    const byId = new Map(jsonRows(dir).map((r) => [r.id, r]));
    assert.equal(byId.get('stalled-run')!.status, 'stalled');
    assert.equal(byId.get('finished')!.status, 'PASSED');
    // A finished run keeps its live document in --json even though result.json set the column.
    assert.deepEqual(byId.get('finished')!.live, finishedStatus);
    assert.equal(byId.get('live-but-done')!.status, 'completed');
  } finally {
    fx.cleanup(dir);
  }
});

test('an unreadable or off-protocol status.json degrades to the pre-status.json behaviour', () => {
  const dir = fx.initRepo();
  try {
    writeTask(dir, 'a-truncated', 'Half-written JSON');
    writeStatusText(dir, 'a-truncated', '{"phase":"executor_wor');
    writeTask(dir, 'b-not-object', 'Not an object');
    writeStatusText(dir, 'b-not-object', '["executor_working"]');
    writeTask(dir, 'c-bad-phase', 'Unknown phase');
    writeStatusText(dir, 'c-bad-phase', JSON.stringify({ ...liveStatus(4), phase: 'thinking' }));
    writeTask(dir, 'd-bad-started', 'Unparseable started_at');
    writeStatusText(dir, 'd-bad-started', JSON.stringify({ ...liveStatus(4), started_at: 'yesterday' }));
    writeTask(dir, 'e-bad-terminal', 'Unknown terminal state');
    writeStatusText(dir, 'e-bad-terminal', JSON.stringify({ ...liveStatus(4), terminal_state: 'exploded' }));
    writeTask(dir, 'f-with-result', 'Malformed status, real result');
    writeStatusText(dir, 'f-with-result', 'not json at all');
    writeResult(dir, 'f-with-result', {});
    writeTask(dir, 'g-no-run', 'No run at all');

    const text = router(dir, ['list']);
    assert.equal(text.code, 0, text.out);
    for (const id of ['a-truncated', 'b-not-object', 'c-bad-phase', 'd-bad-started', 'e-bad-terminal', 'g-no-run']) {
      assert.match(text.out, new RegExp(`${id}\\s+none\\s+-`), text.out);
    }
    assert.match(text.out, /f-with-result\s+completed\s+-/);

    for (const row of jsonRows(dir)) assert.equal(row.live, null, `${String(row.id)} live`);
  } finally {
    fx.cleanup(dir);
  }
});
