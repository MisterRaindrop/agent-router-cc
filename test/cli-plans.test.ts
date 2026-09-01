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

function writeBrainstormMd(dir: string, id: string, content: string): void {
  const d = planDir(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'BRAINSTORM.md'), content);
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
    // `design` is a separate column from `revision`, because they are separate documents with
    // separate revisions. Without it a design at revision 3 with no plan yet reported
    // "unknown" -- see plan-d, where the design revision is the only revision that exists.
    assert.match(text.out, /id\s+design\s+revision\s+stage\s+critique\s+decisions\s+locked/);
    assert.match(text.out, /plan-a\s+-\s+rev-1\s+plan_approved\s+2\s+yes\s+-/);
    assert.match(text.out, /plan-b\s+-\s+rev-9\s+executing\s+1\s+-\s+yes/);
    // plan-c's PLAN.md declares `unexpected`, which is a status nothing recognizes -- marked, not
    // reported as though the directory had no document in it.
    assert.match(text.out, /plan-c\s+-\s+unknown\s+\?unexpected\s+-\s+-\s+-/);
    assert.match(text.out, /plan-d\s+3\s+unknown\s+design_approved\s+-\s+-\s+-/);
    // plan-e has an unparsable PLAN.md over a design at revision 2: the design revision is
    // still reported, and the plan's is still `unknown` rather than borrowing the design's.
    assert.match(text.out, /plan-e\s+2\s+unknown\s+-\s+-\s+-\s+-/);

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { plans: Record<string, unknown>[] }).plans;
    assert.deepEqual(rows, [
      { id: 'plan-a', plan_revision: 'rev-1', design_revision: null, stage: 'plan_approved', critique_round: 2, decisions: true, locked: false },
      { id: 'plan-b', plan_revision: 'rev-9', design_revision: null, stage: 'executing', critique_round: 1, decisions: false, locked: true },
      { id: 'plan-c', plan_revision: null, design_revision: null, stage: '?unexpected', critique_round: null, decisions: false, locked: false },
      { id: 'plan-d', plan_revision: null, design_revision: '3', stage: 'design_approved', critique_round: null, decisions: false, locked: false },
      { id: 'plan-e', plan_revision: null, design_revision: '2', stage: null, critique_round: null, decisions: false, locked: false },
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

// The brainstorm stage was invisible here. A converged brainstorm is a FINISHED stage -- its
// direction and its rejected alternatives are on disk, and the rejection list is what a later
// design review is required to read so a closed road is not re-proposed. Reporting no stage made
// that directory look empty, which is the same blind spot the design revision had.
test('plans reports the brainstorm stage when it is the only document', () => {
  const dir = fx.initRepo();
  try {
    writeBrainstormMd(dir, 'bs-open', '---\nplan_id: bs-open\nstatus: brainstorming\n---\nbody\n');
    writeBrainstormMd(dir, 'bs-done', '---\nplan_id: bs-done\nstatus: converged\n---\nbody\n');
    // A documented rejection is a successful outcome of the stage, so it has to be visible too.
    writeBrainstormMd(dir, 'bs-no', '---\nplan_id: bs-no\nstatus: rejected\n---\nbody\n');
    writeBrainstormMd(dir, 'bs-bad', '---\nplan_id: bs-bad\nstatus: daydreaming\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /bs-open\s+-\s+unknown\s+brainstorming/);
    assert.match(text.out, /bs-done\s+-\s+unknown\s+converged/);
    assert.match(text.out, /bs-no\s+-\s+unknown\s+rejected/);
    // A status no vocabulary recognizes is its own fact and is marked rather than flattened into
    // `-`, which now means only "no document, or no status declared". Neutralization of what the
    // marker carries is pinned by its own test below.
    assert.match(text.out, /bs-bad\s+-\s+unknown\s+\?daydreaming\s/);
  } finally {
    fx.cleanup(dir);
  }
});

// `design_abandoned` is terminal, and it is here because there was no terminal state to reach: a
// design the user stops part-way sat on `design_draft` forever and read as the one unfinished plan.
test('a design the user stopped part-way reports a terminal stage, not a draft', () => {
  const dir = fx.initRepo();
  try {
    writeDesignMd(dir, 'd-stopped', '---\nplan_id: d-stopped\nstatus: design_abandoned\n---\nbody\n');
    writeDesignMd(dir, 'd-open', '---\nplan_id: d-open\nstatus: design_draft\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /d-stopped\s+-\s+unknown\s+design_abandoned/);
    // The draft state still exists and still reads as unfinished -- the new status is an addition,
    // not a rename of the old one.
    assert.match(text.out, /d-open\s+-\s+unknown\s+design_draft/);
  } finally {
    fx.cleanup(dir);
  }
});

// `-` used to mean two different things: no document at all, and a document whose declared status
// nothing recognizes. A typo in this one frontmatter field was therefore invisible in the listing.
test('plans marks an unrecognized status instead of reporting it as no document', () => {
  const dir = fx.initRepo();
  try {
    writePlanMd(dir, 'p-typo', '---\nrevision: 4\nstatus: exceuting\n---\nbody\n');
    writeDesignMd(dir, 'd-typo', '---\nrevision: 2\nstatus: desgin_approved\n---\nbody\n');
    writeBrainstormMd(dir, 'b-typo', '---\nstatus: daydreaming\n---\nbody\n');
    // One recognized status from each of the three vocabularies: these must read exactly as before.
    writePlanMd(dir, 'p-ok', '---\nrevision: 7\nstatus: done\n---\nbody\n');
    writeDesignMd(dir, 'd-ok', '---\nrevision: 1\nstatus: design_draft\n---\nbody\n');
    writeBrainstormMd(dir, 'b-ok', '---\nstatus: converged\n---\nbody\n');
    // A plan directory with no document at all -- this is what `-` still means, and only this.
    mkdirSync(planDir(dir, 'a-bare'), { recursive: true });

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /p-typo\s+-\s+4\s+\?exceuting\s+-\s+-\s+-/);
    assert.match(text.out, /d-typo\s+2\s+unknown\s+\?desgin_approved\s+-\s+-\s+-/);
    assert.match(text.out, /b-typo\s+-\s+unknown\s+\?daydreaming\s+-\s+-\s+-/);
    assert.match(text.out, /p-ok\s+-\s+7\s+done\s+-\s+-\s+-/);
    assert.match(text.out, /d-ok\s+1\s+unknown\s+design_draft\s+-\s+-\s+-/);
    assert.match(text.out, /b-ok\s+-\s+unknown\s+converged\s+-\s+-\s+-/);
    assert.match(text.out, /a-bare\s+-\s+unknown\s+-\s+-\s+-\s+-/);

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { plans: { id: string; stage: string | null }[] }).plans;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.stage])), {
      'a-bare': null,
      'b-ok': 'converged',
      'b-typo': '?daydreaming',
      'd-ok': 'design_draft',
      'd-typo': '?desgin_approved',
      'p-ok': 'done',
      'p-typo': '?exceuting',
    });
  } finally {
    fx.cleanup(dir);
  }
});

// `status:` is arbitrary text from a file and this table is written straight to a terminal, where
// an escape sequence would move the cursor or set a colour instead of being read. The ESC and BEL
// bytes are built by the YAML parser from `\e` and `\a`, so neither byte is literal in this file.
test('a status carrying an escape sequence and control characters is neutralized before printing', () => {
  const dir = fx.initRepo();
  try {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    writeBrainstormMd(dir, 'nasty', '---\nstatus: "danger\\e[31m\\ared\\rmore\\nline"\n---\nbody\n');
    writeBrainstormMd(dir, 'plain', '---\nstatus: converged\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.equal(text.out.includes(esc), false, `no escape byte may reach the terminal: ${JSON.stringify(text.out)}`);
    assert.equal(text.out.includes(bel), false, 'no C0 control character may reach the terminal');
    assert.equal(text.out.includes('\r'), false, 'no carriage return may reach the terminal');
    // Every neutralized byte becomes one `.`, so the declared status stays identifiable.
    assert.match(text.out, /nasty\s+-\s+unknown\s+\?danger\.\[31m\.red\.more\.line\s/);
    const lines = text.out.trimEnd().split('\n');
    assert.equal(lines.length, 4, `header plus two rows, with no smuggled newline: ${JSON.stringify(text.out)}`);
    // The widened stage column is measured like every other one, so the table still lines up.
    const header = lines[1]!;
    const row = lines.find((line) => line.startsWith('plain'))!;
    assert.equal(row.slice(header.indexOf('critique')).startsWith('-'), true, 'critique column must stay aligned');
  } finally {
    fx.cleanup(dir);
  }
});

// Precedence, in both directions.
test('a later document outranks the brainstorm, and a broken plan does not fall back to it', () => {
  const dir = fx.initRepo();
  try {
    // design over brainstorm
    writeBrainstormMd(dir, 'has-design', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'has-design', '---\nrevision: 2\nstatus: design_approved\n---\nbody\n');
    // work plan over both
    writeBrainstormMd(dir, 'has-plan', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'has-plan', '---\nrevision: 1\nstatus: design_approved\n---\nbody\n');
    writePlanMd(dir, 'has-plan', '---\nrevision: 4\nstatus: executing\n---\nbody\n');
    // An unparseable plan keeps the stage unknown: a plan on disk means the earlier stages are
    // done, so reporting "converged" over a broken plan would read as regress, not as damage.
    writeBrainstormMd(dir, 'broken-plan', '---\nstatus: converged\n---\nbody\n');
    writePlanMd(dir, 'broken-plan', '---\nrevision: [\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /has-design\s+2\s+unknown\s+design_approved/);
    assert.match(text.out, /has-plan\s+1\s+4\s+executing/);
    assert.match(text.out, /broken-plan\s+-\s+unknown\s+-/);
  } finally {
    fx.cleanup(dir);
  }
});

// Marking an unrecognized status must not reorder the documents: a recognized status still wins
// wherever it is found, and the mark only fills the gap where every level came up unrecognized.
test('an unrecognized status does not change which document owns the stage', () => {
  const dir = fx.initRepo();
  try {
    // A recognized design outranks a typo in the brainstorm below it.
    writeBrainstormMd(dir, 'typo-brainstorm', '---\nstatus: daydreaming\n---\nbody\n');
    writeDesignMd(dir, 'typo-brainstorm', '---\nrevision: 1\nstatus: design_approved\n---\nbody\n');
    // A typo in the work plan still owns the stage over a recognized design: a plan on disk means
    // the earlier stages are done, so reporting the design's status would read as regress.
    writeDesignMd(dir, 'typo-plan', '---\nrevision: 2\nstatus: design_approved\n---\nbody\n');
    writePlanMd(dir, 'typo-plan', '---\nrevision: 5\nstatus: plan_aproved\n---\nbody\n');
    // With no plan, a typo in the design does not hide a recognized brainstorm: a recognized
    // status is reported exactly as before, at whatever level it is found.
    writeBrainstormMd(dir, 'typo-design', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'typo-design', '---\nrevision: 3\nstatus: desgin_draft\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /typo-brainstorm\s+1\s+unknown\s+design_approved\s/);
    assert.match(text.out, /typo-plan\s+2\s+5\s+\?plan_aproved\s/);
    assert.match(text.out, /typo-design\s+3\s+unknown\s+converged\s/);
  } finally {
    fx.cleanup(dir);
  }
});
