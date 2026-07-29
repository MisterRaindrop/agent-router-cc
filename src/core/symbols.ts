// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { FileSymbols, Sym, SymbolIndex, SymbolKind } from '../domain/types.ts';

// Query logic over an already-built symbol index. PURE: no fs, no tree-sitter -- it
// only reads a SymbolIndex handed in by io/app. This is where the token win lives:
// every query returns a bounded handful of rows, never the whole map, never source.
//
// Boundary (measured, see docs/design/code-intelligence-ab-round1.md): `find` returns
// DEFINITIONS/DECLARATIONS only, not call-sites. "Who invokes X" is a call-site query
// that grep/rg answers; the index does not. Callers must combine the two.

export interface FindRow {
  file: string;
  line: number;
  kind: SymbolKind;
  name: string;
}

export interface FindResult {
  rows: FindRow[];
  truncated: number; // how many matches were dropped past the limit
}

export interface EnclosingResult {
  file: string;
  kind: SymbolKind;
  name: string;
  line: number;
  endLine: number;
}

export interface MethodsResult {
  cls: EnclosingResult | null;
  members: Sym[];
  truncated: number;
}

// Macro/annotation nodes that tree-sitter surfaces as pseudo-declarations inside a
// class body but are not real members. Filtered so `methods` stays signal (measured:
// clang thread-safety annotations leaked into the raw output).
const MEMBER_NOISE = /^(TSA_GUARDED_BY|TSA_PT_GUARDED_BY|DECLARE_|__)/;

function matchFile(idx: SymbolIndex, file: string): FileSymbols | undefined {
  // Accept an exact repo-relative path or a trailing-path/basename suffix, so callers
  // can pass "StorageObjectStorageSource.cpp" without the full prefix.
  return idx.files.find((e) => e.file === file || e.file.endsWith('/' + file));
}

/** Symbols whose name contains `needle`. Definitions rank before declarations. */
export function findSymbol(idx: SymbolIndex, needle: string, limit = 20): FindResult {
  const hits: FindRow[] = [];
  for (const f of idx.files) {
    for (const s of f.symbols) {
      if (s.name.includes(needle)) {
        hits.push({ file: f.file, line: s.line, kind: s.kind, name: s.name });
      }
    }
  }
  // Stable-ish ordering: real definitions (class/struct/fn) before bare decls, then by
  // file then line, so the most useful rows survive truncation.
  hits.sort((a, b) => {
    const da = a.kind === 'decl' ? 1 : 0;
    const db = b.kind === 'decl' ? 1 : 0;
    if (da !== db) return da - db;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  const rows = hits.slice(0, Math.max(0, limit));
  return { rows, truncated: Math.max(0, hits.length - rows.length) };
}

/** The innermost class/function whose span contains `line` in `file`. */
export function enclosing(idx: SymbolIndex, file: string, line: number): EnclosingResult | null {
  const f = matchFile(idx, file);
  if (f === undefined) return null;
  let best: Sym | null = null;
  for (const s of f.symbols) {
    if (s.line <= line && line <= s.endLine) {
      if (best === null || s.endLine - s.line < best.endLine - best.line) best = s;
    }
  }
  if (best === null) return null;
  return { file: f.file, kind: best.kind, name: best.name, line: best.line, endLine: best.endLine };
}

/** Members (fn/decl) whose span falls inside class `className`. Noise filtered. */
export function methodsOf(idx: SymbolIndex, className: string, limit = 40): MethodsResult {
  let cls: EnclosingResult | null = null;
  let clsFile: FileSymbols | undefined;
  for (const f of idx.files) {
    for (const s of f.symbols) {
      if ((s.kind === 'class' || s.kind === 'struct') && s.name === className) {
        cls = { file: f.file, kind: s.kind, name: s.name, line: s.line, endLine: s.endLine };
        clsFile = f;
      }
    }
  }
  if (cls === null || clsFile === undefined) return { cls: null, members: [], truncated: 0 };
  const all = clsFile.symbols.filter(
    (s) =>
      (s.kind === 'fn' || s.kind === 'decl') &&
      s.line > cls!.line &&
      s.endLine <= cls!.endLine &&
      !MEMBER_NOISE.test(s.name),
  );
  const members = all.slice(0, Math.max(0, limit));
  return { cls, members, truncated: Math.max(0, all.length - members.length) };
}

// -- rendering (pure): the SAME bounded text CLI prints and JSON mode mirrors --

export function renderFind(r: FindResult): string {
  if (r.rows.length === 0) return 'no matching symbol';
  const lines = r.rows.map((h) => `${h.file}:${h.line}\t${h.kind} ${h.name}`);
  if (r.truncated > 0) lines.push(`... (${r.truncated} more; refine the name)`);
  return lines.join('\n');
}

export function renderEnclosing(r: EnclosingResult | null): string {
  if (r === null) return 'no enclosing class/function';
  return `${r.file}:${r.line}-${r.endLine}\t${r.kind} ${r.name}`;
}

export function renderMethods(r: MethodsResult): string {
  if (r.cls === null) return 'class not found';
  const lines = [`${r.cls.name} (${r.cls.file}:${r.cls.line}-${r.cls.endLine})`];
  for (const m of r.members) lines.push(`  ${m.line}\t${m.name}`);
  if (r.truncated > 0) lines.push(`  ... (${r.truncated} more)`);
  return lines.join('\n');
}
