// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import { childEnv } from './childEnv.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { describeLoadFailure } from '../src/cli/commands.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: childEnv() });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

const CPP = `namespace N {
class Widget {
public:
  void run();
  int size() const;
};
void Widget::run() {}
}
`;

function repoWithSource(): string {
  const dir = fx.initRepo();
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'widget.cpp'), CPP);
  return dir;
}

test('symbol index: prints only a summary, never dumps the symbol map', () => {
  const dir = repoWithSource();
  const r = router(dir, ['symbol', 'index', 'src']);
  assert.equal(r.code, 0);
  assert.match(r.out, /indexed \d+ files, \d+ symbols/);
  assert.doesNotMatch(r.out, /Widget::run/); // the map itself must not enter output
});

test('symbol find: locates a symbol after indexing (via latest pointer)', () => {
  const dir = repoWithSource();
  router(dir, ['symbol', 'index', 'src']);
  const r = router(dir, ['symbol', 'find', 'Widget']);
  assert.equal(r.code, 0);
  assert.match(r.out, /src\/widget\.cpp:\d+\tclass Widget/);
});

test('symbol find --json: structured rows', () => {
  const dir = repoWithSource();
  router(dir, ['symbol', 'index', 'src']);
  const r = router(dir, ['symbol', 'find', 'Widget', '--json']);
  const parsed = JSON.parse(r.out) as { ok: boolean; result: { rows: { name: string }[] } };
  assert.equal(parsed.ok, true);
  assert.ok(parsed.result.rows.some((x) => x.name === 'Widget'));
});

test('symbol methods: lists members inside the class', () => {
  const dir = repoWithSource();
  router(dir, ['symbol', 'index', 'src']);
  const r = router(dir, ['symbol', 'methods', 'Widget']);
  assert.equal(r.code, 0);
  assert.match(r.out, /run/);
  assert.match(r.out, /size/);
});

test('symbol query before any index: loud degrade to rg, not empty', () => {
  const dir = repoWithSource();
  const r = router(dir, ['symbol', 'find', 'Widget']);
  assert.match(r.out, /no symbol index yet|using rg/);
});

test('disabled by config: master switch off -> loud degrade', () => {
  const dir = repoWithSource();
  mkdirSync(join(dir, '.router'), { recursive: true });
  writeFileSync(join(dir, '.router', 'models.yaml'), 'codeIntelligence:\n  enabled: false\n');
  const r = router(dir, ['symbol', 'find', 'Widget']);
  assert.match(r.out, /disabled by config/);
});

test('symbol callers: finds a caller and ALWAYS prints the reference-only banner', () => {
  const dir = repoWithSource();
  // widget.cpp: Widget::run() calls run()? add a caller relationship.
  writeFileSync(join(dir, 'src', 'widget.cpp'), CPP + '\nvoid caller() { Widget w; w.run(); }\n');
  router(dir, ['symbol', 'index', 'src']);
  const r = router(dir, ['symbol', 'callers', 'run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /reference only/i);
  assert.match(r.out, /NOT authoritative/);
  assert.match(r.out, /rg/); // must tell the agent to confirm completeness with rg
});

test('symbol: unknown subcommand exits 2', () => {
  const dir = repoWithSource();
  const r = router(dir, ['symbol', 'bogus']);
  assert.equal(r.code, 2);
});

// A load failure has to name itself. The runtime throws an Error with an EMPTY message when it
// rejects a grammar's ABI, and `doctor` used to print `UNAVAILABLE ()` -- the one line whose job is
// to explain, explaining nothing. Diagnosing a real occurrence needed a hand-written probe script.
test('doctor names a load failure even when the error carries no message', () => {
  for (const [thrown, expected] of [
    [new Error(''), /Error -- no message; usually a grammar/],
    [Object.assign(new Error(''), { code: 'ENOENT' }), /Error: ENOENT -- no message/],
    [new TypeError('Parser.init is not a function'), /TypeError: Parser\.init is not a function/],
    [Object.assign(new Error('boom'), { code: 'ERR_X' }), /Error: ERR_X: boom/],
  ] as const) {
    const out = describeLoadFailure(thrown);
    assert.match(out, expected, `for ${String(thrown)}`);
    assert.doesNotMatch(out, /^\s*$/, 'a failure must never describe itself as nothing');
  }
});

// The other half: the helper being correct is worth nothing if `doctor` stops calling it. A
// source assertion is weak, and it is here because the strong version is not available -- forcing a
// real grammar-load failure inside a test would mean shipping a broken wasm. It is not decoration:
// reverting the catch to `(e as Error).message` leaves the test above green, which is how this gap
// was found in the first place.
test('doctor routes its load failure through describeLoadFailure', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/cli/commands.ts', import.meta.url)),
    'utf8',
  );
  assert.match(src, /wasmDetail = describeLoadFailure\(e\);/);
  assert.doesNotMatch(src, /wasmDetail = \(e as Error\)\.message;/);
});

test('doctor: reports switches and wasm status', () => {
  const dir = repoWithSource();
  const r = router(dir, ['doctor']);
  assert.match(r.out, /code intel:\s+master=true index=true lsp=true/);
  assert.match(r.out, /tree-sitter:\s+OK/);
});
