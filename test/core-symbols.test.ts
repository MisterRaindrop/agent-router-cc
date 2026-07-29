// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calleesOf,
  callersOf,
  enclosing,
  findSymbol,
  methodsOf,
  renderCallers,
  renderEnclosing,
  renderFind,
  renderMethods,
} from '../src/core/symbols.ts';
import type { Sym, SymbolIndex } from '../src/domain/types.ts';

const sym = (over: Partial<Sym> & Pick<Sym, 'kind' | 'name' | 'line'>): Sym => ({
  endLine: over.line,
  ...over,
});

// A tiny hand-built index that mirrors the real Iceberg dispatch chain shape, so the
// assertions read like the actual A/B task. No fs, no tree-sitter -- pure input.
const idx: SymbolIndex = {
  grammar: 'test',
  files: [
    {
      file: 'src/Storages/ObjectStorage/DataLakes/Iceberg/IcebergMetadata.cpp',
      mtimeMs: 1,
      symbols: [
        sym({ kind: 'fn', name: 'IcebergMetadata::getColumnMapperForObject', line: 1393, endLine: 1404 }),
        sym({ kind: 'fn', name: 'IcebergMetadata::getColumnMapperForCurrentSchema', line: 1406, endLine: 1420 }),
      ],
    },
    {
      file: 'src/Storages/ObjectStorage/DataLakes/Iceberg/SchemaProcessor.h',
      mtimeMs: 1,
      symbols: [
        sym({ kind: 'class', name: 'IcebergSchemaProcessor', line: 78, endLine: 133 }),
        sym({ kind: 'decl', name: 'addIcebergTableSchema', line: 87 }),
        sym({ kind: 'decl', name: 'getColumnMapperById', line: 105 }),
        sym({ kind: 'decl', name: 'TSA_GUARDED_BY', line: 110 }), // noise inside the class
        sym({ kind: 'decl', name: 'outsideMember', line: 200 }), // outside class span
      ],
    },
    {
      file: 'src/Storages/ObjectStorage/DataLakes/IDataLakeMetadata.h',
      mtimeMs: 1,
      symbols: [sym({ kind: 'decl', name: 'getColumnMapperForObject', line: 123 })],
    },
  ],
};

// -- findSymbol --
test('findSymbol: substring match across files', () => {
  const r = findSymbol(idx, 'getColumnMapperForObject');
  assert.equal(r.truncated, 0);
  assert.equal(r.rows.length, 2); // the .cpp def + the base .h decl
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ['IcebergMetadata::getColumnMapperForObject', 'getColumnMapperForObject'],
  );
});

test('findSymbol: definitions rank before declarations', () => {
  const r = findSymbol(idx, 'getColumnMapperForObject');
  assert.equal(r.rows[0]!.kind, 'fn'); // def first
  assert.equal(r.rows[1]!.kind, 'decl'); // decl after
});

test('findSymbol: limit truncates and reports the remainder', () => {
  const r = findSymbol(idx, 'getColumnMapper', 1);
  assert.equal(r.rows.length, 1);
  assert.equal(r.truncated, 3); // 4 total matches, 1 shown
});

test('findSymbol: no match', () => {
  const r = findSymbol(idx, 'doesNotExist');
  assert.equal(r.rows.length, 0);
  assert.equal(r.truncated, 0);
  assert.equal(renderFind(r), 'no matching symbol');
});

// -- enclosing --
test('enclosing: innermost span containing the line', () => {
  const r = enclosing(idx, 'IcebergMetadata.cpp', 1400); // basename match
  assert.notEqual(r, null);
  assert.equal(r!.name, 'IcebergMetadata::getColumnMapperForObject');
  assert.equal(r!.line, 1393);
});

test('enclosing: picks the tighter of two overlapping spans', () => {
  const overlap: SymbolIndex = {
    grammar: 'test',
    files: [
      {
        file: 'a.cpp',
        mtimeMs: 1,
        symbols: [
          sym({ kind: 'class', name: 'Outer', line: 1, endLine: 100 }),
          sym({ kind: 'fn', name: 'Outer::method', line: 40, endLine: 60 }),
        ],
      },
    ],
  };
  const r = enclosing(overlap, 'a.cpp', 50);
  assert.equal(r!.name, 'Outer::method'); // the tighter span wins
});

test('enclosing: line outside any span, and unknown file', () => {
  assert.equal(enclosing(idx, 'IcebergMetadata.cpp', 5000), null);
  assert.equal(enclosing(idx, 'nope.cpp', 1), null);
  assert.equal(renderEnclosing(null), 'no enclosing class/function');
});

// -- methodsOf --
test('methodsOf: members inside the class span, noise filtered, outside excluded', () => {
  const r = methodsOf(idx, 'IcebergSchemaProcessor');
  assert.notEqual(r.cls, null);
  const names = r.members.map((m) => m.name);
  assert.deepEqual(names, ['addIcebergTableSchema', 'getColumnMapperById']);
  assert.equal(names.includes('TSA_GUARDED_BY'), false); // noise dropped
  assert.equal(names.includes('outsideMember'), false); // outside span dropped
});

test('methodsOf: limit truncates', () => {
  const r = methodsOf(idx, 'IcebergSchemaProcessor', 1);
  assert.equal(r.members.length, 1);
  assert.equal(r.truncated, 1);
});

test('methodsOf: unknown class', () => {
  const r = methodsOf(idx, 'NoSuchClass');
  assert.equal(r.cls, null);
  assert.equal(r.members.length, 0);
  assert.equal(renderMethods(r), 'class not found');
});

// -- rendering --
test('renderFind: one row per line, tab-separated, with truncation note', () => {
  const r = findSymbol(idx, 'getColumnMapper', 1);
  const text = renderFind(r);
  const lines = text.split('\n');
  assert.equal(lines.length, 2); // 1 row + the "... more" note
  assert.match(lines[0]!, /\t(fn|decl) /);
  assert.match(lines[1]!, /\.\.\. \(3 more/);
});

test('renderMethods: class header then indented members', () => {
  const text = renderMethods(methodsOf(idx, 'IcebergSchemaProcessor'));
  const lines = text.split('\n');
  assert.match(lines[0]!, /^IcebergSchemaProcessor \(/);
  assert.match(lines[1]!, /^ {2}\d+\t/);
});

// -- approximate call graph (reference only) --
const cgIdx: SymbolIndex = {
  grammar: 'test',
  files: [
    {
      file: 'src/a.cpp',
      mtimeMs: 1,
      symbols: [sym({ kind: 'fn', name: 'A::run', line: 10, endLine: 20 })],
      calls: [
        { caller: 'A::run', callee: 'getColumnMapperById', line: 12 },
        { caller: 'A::run', callee: 'getName', line: 13 },
      ],
    },
    {
      file: 'src/b.cpp',
      mtimeMs: 1,
      symbols: [
        sym({ kind: 'fn', name: 'B::getName', line: 5, endLine: 8 }),
        sym({ kind: 'fn', name: 'C::getName', line: 30, endLine: 33 }), // same simple name
      ],
      calls: [{ caller: 'B::getName', callee: 'getColumnMapperById', line: 6 }],
    },
  ],
};

test('callersOf: finds callers, always flagged reference-only', () => {
  const r = callersOf(cgIdx, 'getColumnMapperById');
  assert.equal(r.referenceOnly, true);
  assert.deepEqual(r.rows.map((x) => x.fn).sort(), ['A::run', 'B::getName']);
});

test('callersOf: ambiguity counts definitions sharing the simple name', () => {
  const r = callersOf(cgIdx, 'getName');
  assert.equal(r.ambiguity, 2); // B::getName and C::getName share "getName"
  assert.equal(r.rows.length, 1); // A::run calls getName
});

test('renderCallers: banner is mandatory and warns to confirm with rg', () => {
  const text = renderCallers(callersOf(cgIdx, 'getName'));
  assert.match(text, /reference only/i);
  assert.match(text, /NOT authoritative/);
  assert.match(text, /rg/);
  assert.match(text, /2 symbols share the name/);
});

test('callersOf: no caller found still carries the banner and an rg hint', () => {
  const text = renderCallers(callersOf(cgIdx, 'neverCalled'));
  assert.match(text, /no caller found/);
  assert.match(text, /reference only/i);
});

test('calleesOf: names called by a function', () => {
  const r = calleesOf(cgIdx, 'A::run');
  assert.equal(r.referenceOnly, true);
  assert.deepEqual(r.rows.map((x) => x.fn).sort(), ['getColumnMapperById', 'getName']);
});
