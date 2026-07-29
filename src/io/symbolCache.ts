// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { writeJsonAtomic } from './atomicWrite.ts';
import { parseSymbols } from './treeSitter.ts';
import type { FileSymbols, SymbolIndex } from '../domain/types.ts';

// Build / load / refresh the persisted symbol index. IMPURE (fs). The cache lives in
// .router/symbols/<hash>.json and is NEVER surfaced to the model -- only per-query
// results (a few lines) are. See docs/design/code-intelligence-design.md.

const SRC_RE = /\.(cpp|h|hpp|cc|cxx|hh)$/;
const SKIP_DIR = new Set(['.git', 'node_modules', '.router', 'dist']);

export interface BuildLimits {
  maxFiles: number;
  maxBytes: number;
}
export interface BuildResult {
  files: number;
  symbols: number;
  reparsed: number; // how many files were (re)parsed this run vs reused from cache
  degraded?: { reason: string };
}

/** Stable cache id for a set of roots (order-independent), keyed under .router/symbols/. */
export function hashRoots(roots: string[]): string {
  const norm = roots.map((r) => resolve(r)).sort();
  return createHash('sha256').update(norm.join('\n')).digest('hex').slice(0, 16);
}

function walkFiles(root: string, acc: string[]): void {
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (SRC_RE.test(root)) acc.push(root);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(root)) {
    if (SKIP_DIR.has(name)) continue;
    walkFiles(resolve(root, name), acc);
  }
}

function loadRaw(cachePath: string): SymbolIndex | null {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as SymbolIndex;
  } catch {
    return null;
  }
}

/**
 * (Re)build the index over `roots`, writing `cachePath`. Incremental: a file whose
 * mtime is unchanged since the last build is reused, not re-parsed. Enforces the size
 * cap by FAILING LOUD (degraded) rather than silently indexing a giant tree.
 */
export async function buildIndex(
  roots: string[],
  cachePath: string,
  repoRoot: string,
  limits: BuildLimits,
): Promise<BuildResult> {
  const files: string[] = [];
  for (const r of roots) walkFiles(resolve(r), files);

  if (files.length > limits.maxFiles) {
    return { files: files.length, symbols: 0, reparsed: 0, degraded: { reason: `scope too large: ${files.length} files > maxFiles ${limits.maxFiles}` } };
  }

  const prev = loadRaw(cachePath);
  const prevByFile = new Map<string, FileSymbols>();
  if (prev !== null) for (const f of prev.files) prevByFile.set(f.file, f);

  const out: FileSymbols[] = [];
  let grammar = prev?.grammar ?? '';
  let symbols = 0;
  let reparsed = 0;
  let bytes = 0;

  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const st = statSync(abs);
    const cached = prevByFile.get(rel);
    if (cached !== undefined && cached.mtimeMs === st.mtimeMs) {
      out.push(cached);
      symbols += cached.symbols.length;
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    bytes += src.length;
    if (bytes > limits.maxBytes) {
      return { files: files.length, symbols: 0, reparsed, degraded: { reason: `scope too large: >${limits.maxBytes} bytes of source` } };
    }
    const parsed = await parseSymbols(src);
    grammar = parsed.grammar;
    out.push({ file: rel, mtimeMs: st.mtimeMs, symbols: parsed.syms });
    symbols += parsed.syms.length;
    reparsed++;
  }

  writeJsonAtomic(cachePath, { grammar, files: out } satisfies SymbolIndex);
  return { files: files.length, symbols, reparsed };
}

/** Load a prebuilt index. Throws (via caller) if the cache is missing/corrupt. */
export function loadIndex(cachePath: string): SymbolIndex | null {
  return loadRaw(cachePath);
}

/**
 * Query-time freshness: re-stat every KNOWN file and re-parse only those whose mtime
 * changed since the cache was written, so a query never answers from stale symbols.
 * (New files that appeared since the last full `index` are NOT discovered here -- that
 * needs a rebuild; callers should note this.) Returns how many files were re-parsed.
 */
export async function refreshIndex(cachePath: string, repoRoot: string): Promise<{ index: SymbolIndex; reparsed: number } | null> {
  const idx = loadRaw(cachePath);
  if (idx === null) return null;
  const out: FileSymbols[] = [];
  let grammar = idx.grammar;
  let reparsed = 0;
  let changed = false;
  for (const f of idx.files) {
    const abs = resolve(repoRoot, f.file);
    let st;
    try {
      st = statSync(abs);
    } catch {
      changed = true; // file deleted -> drop it from the index
      continue;
    }
    if (st.mtimeMs === f.mtimeMs) {
      out.push(f);
      continue;
    }
    const parsed = await parseSymbols(readFileSync(abs, 'utf8'));
    grammar = parsed.grammar;
    out.push({ file: f.file, mtimeMs: st.mtimeMs, symbols: parsed.syms });
    reparsed++;
    changed = true;
  }
  const refreshed: SymbolIndex = { grammar, files: out };
  if (changed && existsSync(cachePath)) writeJsonAtomic(cachePath, refreshed);
  return { index: refreshed, reparsed };
}
