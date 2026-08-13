// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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

function planDir(dir: string, id: string): string {
  return join(dir, '.router', 'plans', id);
}

function writePlanMd(dir: string, id: string, content: string): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'PLAN.md'), content);
}

function writeDesignMd(dir: string, id: string, content: string): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'DESIGN.md'), content);
}

function writeCritique(dir: string, id: string, round: number): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `critique-${round}.md`), `round ${round}\n`);
}

function writeDecisions(dir: string, id: string): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'DECISIONS.md'), '# decisions\n');
}

function writeHeldLock(dir: string, id: string): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'spec.lock'),
    JSON.stringify({ pid: process.pid, startedAtMs: Date.now(), beatAtMs: Date.now() }),
  );
}

test('plans reports "no plans" when .router/plans is missing or empty', () => {
  const dir = fx.initRepo();
  try {
    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /No plans in \.router\/plans\./);
    assert.equal(existsSync(join(dir, '.router')), false, 'plans must not scaffold .router');

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    assert.deepEqual((JSON.parse(json.out) as { plans: unknown[] }).plans, []);

    // an existing but empty .router/plans directory behaves the same way
    mkdirSync(join(dir, '.router', 'plans'), { recursive: true });
    const emptyDir = router(dir, ['plans']);
    assert.equal(emptyDir.code, 0, emptyDir.out);
    assert.match(emptyDir.out, /No plans in \.router\/plans\./);
  } finally {
    fx.cleanup(dir);
  }
});

test('plans shows current and legacy revisions plus the furthest recognized document stage', () => {
  const dir = fx.initRepo();
  try {
    writePlanMd(dir, 'plan-a', '---\nplan_id: plan-a\nrevision: rev-1\nstatus: plan_approved\n---\nbody\n');
    writeCritique(dir, 'plan-a', 1);
    writeCritique(dir, 'plan-a', 2);
    writeDecisions(dir, 'plan-a');

    writePlanMd(dir, 'plan-b', '---\nplan_id: plan-b\nplan_revision: rev-9\nstatus: executing\n---\nbody\n');
    writeCritique(dir, 'plan-b', 1);

    writePlanMd(dir, 'plan-c', '---\nplan_id: plan-c\nstatus: unexpected\n---\nbody\n');
    writeDesignMd(dir, 'plan-d', '---\nplan_id: plan-d\nrevision: 3\nstatus: design_approved\n---\nbody\n');
    writeDesignMd(dir, 'plan-e', '---\nplan_id: plan-e\nrevision: 2\nstatus: design_approved\n---\nbody\n');
    writePlanMd(dir, 'plan-e', '---\nrevision: [\nstatus: plan_approved\n---\nbody\n');

    writeHeldLock(dir, 'plan-b');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /id\s+revision\s+stage\s+critique\s+decisions\s+locked/);
    assert.match(text.out, /plan-a\s+rev-1\s+plan_approved\s+2\s+yes\s+-/);
    assert.match(text.out, /plan-b\s+rev-9\s+executing\s+1\s+-\s+yes/);
    assert.match(text.out, /plan-c\s+unknown\s+-\s+-\s+-\s+-/);
    assert.match(text.out, /plan-d\s+unknown\s+design_approved\s+-\s+-\s+-/);
    assert.match(text.out, /plan-e\s+unknown\s+-\s+-\s+-\s+-/);

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { plans: Record<string, unknown>[] }).plans;
    assert.deepEqual(rows, [
      { id: 'plan-a', plan_revision: 'rev-1', stage: 'plan_approved', critique_round: 2, decisions: true, locked: false },
      { id: 'plan-b', plan_revision: 'rev-9', stage: 'executing', critique_round: 1, decisions: false, locked: true },
      { id: 'plan-c', plan_revision: null, stage: null, critique_round: null, decisions: false, locked: false },
      { id: 'plan-d', plan_revision: null, stage: 'design_approved', critique_round: null, decisions: false, locked: false },
      { id: 'plan-e', plan_revision: null, stage: null, critique_round: null, decisions: false, locked: false },
    ]);
  } finally {
    fx.cleanup(dir);
  }
});

test('plans sizes columns from their longest values so a long id cannot swallow revision', () => {
  const dir = fx.initRepo();
  try {
    const id = '2026-08-12-a-design-plan-id-that-is-longer-than-the-old-width';
    writePlanMd(dir, id, `---\nplan_id: ${id}\nrevision: revision-with-a-long-value\nstatus: done\n---\nbody\n`);

    const result = router(dir, ['plans']);
    assert.equal(result.code, 0, result.out);
    const lines = result.out.trimEnd().split('\n');
    const header = lines[1]!;
    const row = lines[2]!;
    for (const [heading, value] of [
      ['revision', 'revision-with-a-long-value'],
      ['stage', 'done'],
      ['critique', '-'],
      ['decisions', '-'],
      ['locked', '-'],
    ] as const) {
      assert.equal(row.slice(header.indexOf(heading)).startsWith(value), true, `${heading} column must stay aligned`);
    }
    assert.equal(row[id.length], ' ', 'id and revision must have at least one separating space');
  } finally {
    fx.cleanup(dir);
  }
});
