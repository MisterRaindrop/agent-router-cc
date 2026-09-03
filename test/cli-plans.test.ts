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
    assert.match(text.out, /plan-e\s+2\s+unknown\s+!unreadable\s+-\s+-\s+-/);

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { plans: Record<string, unknown>[] }).plans;
    assert.deepEqual(rows, [
      { id: 'plan-a', plan_revision: 'rev-1', design_revision: null, stage: 'plan_approved', critique_round: 2, decisions: true, locked: false },
      { id: 'plan-b', plan_revision: 'rev-9', design_revision: null, stage: 'executing', critique_round: 1, decisions: false, locked: true },
      { id: 'plan-c', plan_revision: null, design_revision: null, stage: '?unexpected', critique_round: null, decisions: false, locked: false },
      { id: 'plan-d', plan_revision: null, design_revision: '3', stage: 'design_approved', critique_round: null, decisions: false, locked: false },
      { id: 'plan-e', plan_revision: null, design_revision: '2', stage: '!unreadable', critique_round: null, decisions: false, locked: false },
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

// An empty value, an empty string and a blank string are the same fact as no field at all --
// nothing was declared -- so they have to read like their YAML-null twin. A bare `?` marks nothing
// and tells the reader less than `-` does.
test('a status whose value is empty or blank is not a declared status', () => {
  const dir = fx.initRepo();
  try {
    writeBrainstormMd(dir, 'b-bare-value', '---\nplan_id: b-bare-value\nstatus:\n---\nbody\n');
    writeBrainstormMd(dir, 'b-empty', '---\nstatus: ""\n---\nbody\n');
    writeBrainstormMd(dir, 'b-blank', '---\nstatus: "   "\n---\nbody\n');
    // Plain spaces around the value are padding and are stripped, so the file's own indentation
    // cannot rag the column. The trailing TAB is NOT padding: it is a control character, and this
    // column exists to show that something is in the field. It survives as one `.`, which is both
    // one terminal cell and more than the reader used to be told.
    writeBrainstormMd(dir, 'b-padded', '---\nstatus: "  daydreaming\\t"\n---\nbody\n');
    // Recognition is still exact, so a padded copy of a recognized word is marked rather than
    // quietly accepted as that word -- the document does not say `converged`.
    writeBrainstormMd(dir, 'b-padded-known', '---\nstatus: " converged "\n---\nbody\n');
    // Decided deliberately: a value that is only control characters IS declared. Something is in
    // that field, and reporting `-` would hide a corrupted document. Control characters are not
    // whitespace, so the raw value answers "yes, something was written".
    writeBrainstormMd(dir, 'b-control', '---\nstatus: "\\e\\a"\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /b-bare-value\s+-\s+unknown\s+-\s+-\s+-\s+-/);
    assert.match(text.out, /b-blank\s+-\s+unknown\s+-\s+-\s+-\s+-/);
    assert.match(text.out, /b-control\s+-\s+unknown\s+\?\.\.\s+-\s+-\s+-/);
    assert.match(text.out, /b-empty\s+-\s+unknown\s+-\s+-\s+-\s+-/);
    assert.match(text.out, /b-padded\s+-\s+unknown\s+\?daydreaming\.\s+-\s+-\s+-/);
    assert.match(text.out, /b-padded-known\s+-\s+unknown\s+\?converged\s+-\s+-\s+-/);
    assert.equal(
      text.out.includes(String.fromCharCode(27)),
      false,
      `no escape byte may reach the terminal: ${JSON.stringify(text.out)}`,
    );

    const json = router(dir, ['plans', '--json']);
    assert.equal(json.code, 0, json.out);
    const rows = (JSON.parse(json.out) as { plans: { id: string; stage: string | null }[] }).plans;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.stage])), {
      'b-bare-value': null,
      'b-blank': null,
      'b-control': '?..',
      'b-empty': null,
      'b-padded': '?daydreaming.',
      'b-padded-known': '?converged',
    });
  } finally {
    fx.cleanup(dir);
  }
});

// The sanitizer was added for the stage column and the other three stayed raw -- a directory name
// and both revisions are arbitrary text out of the same files. Measured before this test existed:
// `revision: "r<ESC>[31mRED"` put two escape bytes on the terminal.
test('every text column is sanitized, not only the one a defect was found in', () => {
  const dir = fx.initRepo();
  try {
    const esc = String.fromCharCode(27);
    writePlanMd(dir, 'p-rev', '---\nrevision: "r\\e[31mRED"\nstatus: done\n---\nbody\n');
    writeDesignMd(dir, 'd-rev', '---\nrevision: "d\\e[32mGRN"\nstatus: design_draft\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.equal(text.out.includes(esc), false, `no escape byte may reach the terminal: ${JSON.stringify(text.out)}`);
    // The neutralized value is still identifiable, so the reader can see what the file holds.
    assert.match(text.out, /p-rev\s+-\s+r\.\[31mRED\s+done/);
    assert.match(text.out, /d-rev\s+d\.\[32mGRN\s+unknown\s+design_draft/);
  } finally {
    fx.cleanup(dir);
  }
});

// A frontmatter scalar has no size limit, and the whole value used to reach the row, the width
// calculation and stdout. One plan could make the listing unreadable.
test('a huge value is bounded in the table and kept whole in --json', () => {
  const dir = fx.initRepo();
  try {
    const long = 'x'.repeat(5000);
    writeBrainstormMd(dir, 'huge', `---\nstatus: "${long}"\n---\nbody\n`);
    writePlanMd(dir, 'huge-rev', `---\nrevision: "${'y'.repeat(5000)}"\nstatus: done\n---\nbody\n`);

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    for (const line of text.out.split('\n')) {
      assert.ok(line.length < 200, `a row grew without bound: ${line.length} chars`);
    }
    assert.match(text.out, /huge\s+-\s+unknown\s+\?x+\.\.\.\s/);
    assert.match(text.out, /huge-rev\s+-\s+y+\.\.\.\s+done/);

    // The full value is still available where a caller can ask for it deliberately.
    const json = router(dir, ['plans', '--json']);
    const rows = (JSON.parse(json.out) as { plans: { id: string; stage: string | null }[] }).plans;
    assert.equal(rows.find((r) => r.id === 'huge')?.stage?.length, long.length + 1);
  } finally {
    fx.cleanup(dir);
  }
});

// `String.trim()` removes TAB, CR, LF, VT, FF, NBSP, FEFF and U+2028 as whitespace, so deciding
// "was anything declared" with it made `status: "\t\r"` render `-` while `status: "\e\a"` rendered
// `?..` -- one rule answering two ways. A control character is a corrupted field, not an author
// writing nothing, and `-` there hides the damage this column exists to show.
test('a control-character status is declared; only plain spaces are not', () => {
  const dir = fx.initRepo();
  try {
    // Every one of these is whitespace to trim() and must NOT be read as "nothing declared".
    writeBrainstormMd(dir, 'a-tab-cr', '---\nstatus: "\\t\\r"\n---\nbody\n');
    writeBrainstormMd(dir, 'b-lf', '---\nstatus: "\\n"\n---\nbody\n');
    writeBrainstormMd(dir, 'c-vt-ff', '---\nstatus: "\\v\\f"\n---\nbody\n');
    writeBrainstormMd(dir, 'd-nbsp', '---\nstatus: "\\u00a0"\n---\nbody\n');
    writeBrainstormMd(dir, 'e-bom', '---\nstatus: "\\ufeff"\n---\nbody\n');
    writeBrainstormMd(dir, 'f-linesep', '---\nstatus: "\\u2028"\n---\nbody\n');
    // ...and these three are the author writing nothing.
    writeBrainstormMd(dir, 'g-empty', '---\nstatus: ""\n---\nbody\n');
    writeBrainstormMd(dir, 'h-spaces', '---\nstatus: "   "\n---\nbody\n');
    writeBrainstormMd(dir, 'i-null', '---\nstatus:\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    for (const id of ['a-tab-cr', 'b-lf', 'c-vt-ff', 'd-nbsp', 'e-bom', 'f-linesep']) {
      assert.match(text.out, new RegExp(`${id}\\s+-\\s+unknown\\s+\\?\\.`), `${id} must read as declared`);
    }
    for (const id of ['g-empty', 'h-spaces', 'i-null']) {
      assert.match(text.out, new RegExp(`${id}\\s+-\\s+unknown\\s+-\\s`), `${id} must read as nothing declared`);
    }
    // Whatever those bytes were, none of them reached the terminal.
    assert.doesNotMatch(text.out, /[^\x20-\x7e\n]/, 'a row carried a byte outside printable ASCII');
  } finally {
    fx.cleanup(dir);
  }
});

// The behaviours above were all verified by hand and none of them had an assertion. A test that
// exists only for the shape someone happened to try is why `\t` and `\e` diverged in the first place.
test('non-string and non-ASCII statuses render predictably', () => {
  const dir = fx.initRepo();
  try {
    writeBrainstormMd(dir, 'a-number', '---\nstatus: 123\n---\nbody\n');
    writeBrainstormMd(dir, 'b-bool', '---\nstatus: true\n---\nbody\n');
    // Neither a mapping nor a sequence is a status; both read as nothing declared rather than
    // being stringified into the column.
    writeBrainstormMd(dir, 'c-mapping', '---\nstatus: {a: 1}\n---\nbody\n');
    writeBrainstormMd(dir, 'd-sequence', '---\nstatus: [a, b]\n---\nbody\n');
    writeBrainstormMd(dir, 'e-del-c1', '---\nstatus: "x\\x7fy\\x85z"\n---\nbody\n');
    writeBrainstormMd(dir, 'f-wide', '---\nstatus: "\\u5bbd\\u5b57"\n---\nbody\n');
    // A parseable document that simply has no `status` key: absent, not unrecognized.
    writeBrainstormMd(dir, 'g-no-key', '---\nplan_id: g-no-key\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /a-number\s+-\s+unknown\s+\?123\s/);
    assert.match(text.out, /b-bool\s+-\s+unknown\s+\?true\s/);
    assert.match(text.out, /c-mapping\s+-\s+unknown\s+-\s/);
    assert.match(text.out, /d-sequence\s+-\s+unknown\s+-\s/);
    assert.match(text.out, /e-del-c1\s+-\s+unknown\s+\?x\.y\.z\s/);
    assert.match(text.out, /f-wide\s+-\s+unknown\s+\?\.\.\s/);
    assert.match(text.out, /g-no-key\s+-\s+unknown\s+-\s/);
  } finally {
    fx.cleanup(dir);
  }
});

// Two documents both unrecognized: which one the row reports has to be pinned, or a later
// refactor changes it by accident and nothing notices.
test('with every level unrecognized, the marked stage follows the same order as a recognized one', () => {
  const dir = fx.initRepo();
  try {
    writeBrainstormMd(dir, 'two-typos', '---\nstatus: bs_typo\n---\nbody\n');
    writeDesignMd(dir, 'two-typos', '---\nrevision: 4\nstatus: dz_typo\n---\nbody\n');
    writeBrainstormMd(dir, 'three-typos', '---\nstatus: bs_typo\n---\nbody\n');
    writeDesignMd(dir, 'three-typos', '---\nrevision: 4\nstatus: dz_typo\n---\nbody\n');
    writePlanMd(dir, 'three-typos', '---\nrevision: 9\nstatus: pl_typo\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /two-typos\s+4\s+unknown\s+\?dz_typo\s/);
    assert.match(text.out, /three-typos\s+4\s+9\s+\?pl_typo\s/);
  } finally {
    fx.cleanup(dir);
  }
});

// `-` used to answer two questions at once one level down as well: "there is no document" and
// "the document is there and I cannot read it". The second is damage and the first is a stage not
// started, and a listing that renders them alike hides the damage -- the same conflation this
// column was fixed for, inside the owning document instead of across documents.
test('a document that exists and cannot be read says so, rather than reporting nothing', () => {
  const dir = fx.initRepo();
  try {
    // The three ways a document reaches the listing unusable, all one fact from here.
    writePlanMd(dir, 'a-bad-yaml', '---\nrevision: [\n---\nbody\n');
    writeDesignMd(dir, 'b-no-frontmatter', 'just prose, no frontmatter block\n');
    writeBrainstormMd(dir, 'c-empty-file', '');
    // Absence still reads as absence: an empty plan directory is not damage.
    mkdirSync(planDir(dir, 'd-no-documents'), { recursive: true });
    // A document that parses and simply declares no stage is also not damage.
    writeDesignMd(dir, 'e-no-status', '---\nplan_id: e-no-status\nrevision: 3\n---\nbody\n');
    // And a status literally spelled `unreadable` carries the OTHER marker, so the two never
    // collide: `?` reports what the field says, `!` reports there was nothing to read.
    writeBrainstormMd(dir, 'f-says-unreadable', '---\nstatus: unreadable\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /a-bad-yaml\s+-\s+unknown\s+!unreadable\s/);
    assert.match(text.out, /b-no-frontmatter\s+-\s+unknown\s+!unreadable\s/);
    assert.match(text.out, /c-empty-file\s+-\s+unknown\s+!unreadable\s/);
    assert.match(text.out, /d-no-documents\s+-\s+unknown\s+-\s/);
    assert.match(text.out, /e-no-status\s+3\s+unknown\s+-\s/);
    assert.match(text.out, /f-says-unreadable\s+-\s+unknown\s+\?unreadable\s/);

    const json = router(dir, ['plans', '--json']);
    const rows = (JSON.parse(json.out) as { plans: { id: string; stage: string | null }[] }).plans;
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.stage])), {
      'a-bad-yaml': '!unreadable',
      'b-no-frontmatter': '!unreadable',
      'c-empty-file': '!unreadable',
      'd-no-documents': null,
      'e-no-status': null,
      'f-says-unreadable': '?unreadable',
    });
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
    // An unparseable plan owns the stage and reports damage: a plan on disk means the earlier
    // stages are done, so reporting "converged" over a broken plan would read as regress -- and
    // `-` would read as "no plan here", which is also not what happened.
    writeBrainstormMd(dir, 'broken-plan', '---\nstatus: converged\n---\nbody\n');
    writePlanMd(dir, 'broken-plan', '---\nrevision: [\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /has-design\s+2\s+unknown\s+design_approved/);
    assert.match(text.out, /has-plan\s+1\s+4\s+executing/);
    assert.match(text.out, /broken-plan\s+-\s+unknown\s+!unreadable/);
  } finally {
    fx.cleanup(dir);
  }
});

// Which document owns the stage is decided by which one EXISTS, not by which one happens to have a
// status this build recognizes. The difference was a blind spot one level up from the one the mark
// was added for: a DESIGN.md declaring `desgin_draft` fell through to a `converged` BRAINSTORM, so
// the listing reported a finished earlier stage and the typo in the design was invisible.
test('the document that exists owns the stage, even when its status is not recognized', () => {
  const dir = fx.initRepo();
  try {
    // The case that used to lie: a typo in the design, a recognized status below it.
    writeBrainstormMd(dir, 'a-design-typo', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'a-design-typo', '---\nrevision: 3\nstatus: desgin_draft\n---\nbody\n');
    // Same shape one level up, and this one already behaved: a typo in the plan.
    writeBrainstormMd(dir, 'b-plan-typo', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'b-plan-typo', '---\nrevision: 2\nstatus: design_approved\n---\nbody\n');
    writePlanMd(dir, 'b-plan-typo', '---\nrevision: 7\nstatus: pl_typo\n---\nbody\n');
    // A design that exists but cannot be parsed owns the stage too, and says so: not the
    // brainstorm's status, and not `-`, which would claim there is no design at all.
    writeBrainstormMd(dir, 'c-design-broken', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'c-design-broken', 'no frontmatter at all\n');
    // And with no design at all, the brainstorm still owns it -- ownership moved, it did not vanish.
    writeBrainstormMd(dir, 'd-brainstorm-only', '---\nstatus: converged\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /a-design-typo\s+3\s+unknown\s+\?desgin_draft\s/);
    assert.match(text.out, /b-plan-typo\s+2\s+7\s+\?pl_typo\s/);
    assert.match(text.out, /c-design-broken\s+-\s+unknown\s+!unreadable\s/);
    assert.match(text.out, /d-brainstorm-only\s+-\s+unknown\s+converged\s/);
  } finally {
    fx.cleanup(dir);
  }
});

// The mark reports what the owning document declares; it does not move ownership. Ownership is the
// test above -- whichever document exists, highest first. So a typo is reported at the level that
// holds it, and a recognized status is reported unchanged at the level that holds it.
test('the mark reports the owning document and does not move ownership', () => {
  const dir = fx.initRepo();
  try {
    // A design that exists outranks the brainstorm below it, typo or not -- here it is recognized.
    writeBrainstormMd(dir, 'typo-brainstorm', '---\nstatus: daydreaming\n---\nbody\n');
    writeDesignMd(dir, 'typo-brainstorm', '---\nrevision: 1\nstatus: design_approved\n---\nbody\n');
    // A typo in the work plan still owns the stage over a recognized design: a plan on disk means
    // the earlier stages are done, so reporting the design's status would read as regress. This
    // level always behaved; the design level is what this release brought into line with it.
    writeDesignMd(dir, 'typo-plan', '---\nrevision: 2\nstatus: design_approved\n---\nbody\n');
    writePlanMd(dir, 'typo-plan', '---\nrevision: 5\nstatus: plan_aproved\n---\nbody\n');
    // A typo in the design is reported AT the design, not hidden behind the brainstorm below it.
    // The design exists, so the design owns the stage -- see the ownership test below.
    writeBrainstormMd(dir, 'typo-design', '---\nstatus: converged\n---\nbody\n');
    writeDesignMd(dir, 'typo-design', '---\nrevision: 3\nstatus: desgin_draft\n---\nbody\n');

    const text = router(dir, ['plans']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /typo-brainstorm\s+1\s+unknown\s+design_approved\s/);
    assert.match(text.out, /typo-plan\s+2\s+5\s+\?plan_aproved\s/);
    assert.match(text.out, /typo-design\s+3\s+unknown\s+\?desgin_draft\s/);
  } finally {
    fx.cleanup(dir);
  }
});
