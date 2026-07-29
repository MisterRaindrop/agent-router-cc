// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import {
  calleesOf,
  callersOf,
  enclosing,
  findSymbol,
  methodsOf,
  renderCallees,
  renderCallers,
  renderEnclosing,
  renderFind,
  renderMethods,
} from '../core/symbols.ts';
import { buildIndex, hashRoots, loadIndex, refreshIndex } from '../io/symbolCache.ts';
import { modelsYamlPath } from './modelConfig.ts';
import type { RouterPaths } from '../io/paths.ts';
import type { CodeIntelConfig } from '../domain/types.ts';

// Orchestrates the symbol index: config, build (summary only -- the map never enters
// context), and query (freshness refresh -> pure core query -> bounded text). IMPURE.

export const DEFAULT_CODE_INTEL: CodeIntelConfig = {
  enabled: true,
  index: { enabled: true, scope: ['.'], maxFiles: 20000, maxBytes: 500_000_000, refresh: 'query' },
  lsp: { enabled: true },
};

/** Bundled default overlaid with `.router/models.yaml`'s `codeIntelligence:` block. */
export function loadCodeIntelConfig(paths: RouterPaths): CodeIntelConfig {
  const cfg: CodeIntelConfig = JSON.parse(JSON.stringify(DEFAULT_CODE_INTEL));
  let raw: unknown;
  try {
    raw = load(readFileSync(modelsYamlPath(paths), 'utf8'), { schema: JSON_SCHEMA });
  } catch {
    return cfg;
  }
  const o = (raw as Record<string, unknown> | null)?.codeIntelligence;
  if (typeof o !== 'object' || o === null) return cfg;
  const c = o as Record<string, unknown>;
  if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
  const idx = c.index as Record<string, unknown> | undefined;
  if (idx !== undefined) {
    if (typeof idx.enabled === 'boolean') cfg.index.enabled = idx.enabled;
    if (Array.isArray(idx.scope)) cfg.index.scope = idx.scope.filter((s): s is string => typeof s === 'string');
    if (typeof idx.maxFiles === 'number') cfg.index.maxFiles = idx.maxFiles;
    if (typeof idx.maxBytes === 'number') cfg.index.maxBytes = idx.maxBytes;
    if (idx.refresh === 'query' || idx.refresh === 'manual') cfg.index.refresh = idx.refresh;
  }
  const lsp = c.lsp as Record<string, unknown> | undefined;
  if (lsp !== undefined && typeof lsp.enabled === 'boolean') cfg.lsp.enabled = lsp.enabled;
  return cfg;
}

export interface Degraded {
  degraded: true;
  reason: string;
}
export function isDegraded(x: unknown): x is Degraded {
  return typeof x === 'object' && x !== null && (x as Degraded).degraded === true;
}

// The index feature is off unless BOTH the master and the index switch are on.
function indexEnabled(cfg: CodeIntelConfig): Degraded | null {
  if (!cfg.enabled) return { degraded: true, reason: 'code intelligence disabled by config (codeIntelligence.enabled=false); using rg' };
  if (!cfg.index.enabled) return { degraded: true, reason: 'symbol index disabled by config (codeIntelligence.index.enabled=false); using rg' };
  return null;
}

function rootsFor(paths: RouterPaths, cfg: CodeIntelConfig, dirs: string[]): string[] {
  const chosen = dirs.length > 0 ? dirs : cfg.index.scope;
  return chosen.map((d) => resolve(paths.repoRoot, d));
}

export interface IndexOutcome {
  files: number;
  symbols: number;
  reparsed: number;
  cache: string;
}

export async function runIndex(paths: RouterPaths, cfg: CodeIntelConfig, dirs: string[]): Promise<IndexOutcome | Degraded> {
  const gate = indexEnabled(cfg);
  if (gate !== null) return gate;
  const roots = rootsFor(paths, cfg, dirs);
  const hash = hashRoots(roots);
  const cache = paths.symbolCache(hash);
  const r = await buildIndex(roots, cache, paths.repoRoot, { maxFiles: cfg.index.maxFiles, maxBytes: cfg.index.maxBytes });
  if (r.degraded !== undefined) return { degraded: true, reason: `${r.degraded.reason}; narrow codeIntelligence.index.scope / raise maxFiles / disable; using rg` };
  // Record this as the "latest" index so a bare query (`router symbol find X`) resolves
  // to whatever scope was last indexed, without the caller re-stating the dirs.
  mkdirSync(paths.symbolsDir, { recursive: true });
  writeFileSync(paths.symbolLatest, hash);
  return { files: r.files, symbols: r.symbols, reparsed: r.reparsed, cache };
}

export interface QueryOutcome {
  text: string;
  data: unknown;
  reparsed: number;
}

export async function runQuery(
  paths: RouterPaths,
  cfg: CodeIntelConfig,
  sub: string,
  args: {
    name?: string | undefined;
    file?: string | undefined;
    line?: number | undefined;
    cls?: string | undefined;
    limit?: number | undefined;
    dirs: string[];
  },
): Promise<QueryOutcome | Degraded> {
  const gate = indexEnabled(cfg);
  if (gate !== null) return gate;
  // Resolve which cache to query: explicit dirs -> that scope; otherwise the "latest"
  // built index if one exists; else fall back to the configured default scope.
  let cache: string;
  if (args.dirs.length > 0) {
    cache = paths.symbolCache(hashRoots(rootsFor(paths, cfg, args.dirs)));
  } else if (existsSync(paths.symbolLatest)) {
    cache = paths.symbolCache(readFileSync(paths.symbolLatest, 'utf8').trim());
  } else {
    cache = paths.symbolCache(hashRoots(rootsFor(paths, cfg, [])));
  }
  if (!existsSync(cache)) {
    return { degraded: true, reason: 'no symbol index yet; run `router symbol index [dirs]` first; using rg' };
  }

  let index;
  let reparsed = 0;
  if (cfg.index.refresh === 'query') {
    const r = await refreshIndex(cache, paths.repoRoot);
    if (r === null) return { degraded: true, reason: 'symbol index unreadable; rebuild with `router symbol index`; using rg' };
    index = r.index;
    reparsed = r.reparsed;
  } else {
    index = loadIndex(cache);
    if (index === null) return { degraded: true, reason: 'symbol index unreadable; rebuild with `router symbol index`; using rg' };
  }

  if (sub === 'find') {
    const r = findSymbol(index, args.name ?? '', args.limit);
    return { text: renderFind(r), data: r, reparsed };
  }
  if (sub === 'enclosing') {
    const r = enclosing(index, args.file ?? '', args.line ?? 0);
    return { text: renderEnclosing(r), data: r, reparsed };
  }
  if (sub === 'methods') {
    const r = methodsOf(index, args.cls ?? '', args.limit);
    return { text: renderMethods(r), data: r, reparsed };
  }
  if (sub === 'callers') {
    const r = callersOf(index, args.name ?? '', args.limit);
    return { text: renderCallers(r), data: r, reparsed };
  }
  if (sub === 'callees') {
    const r = calleesOf(index, args.name ?? '', args.limit);
    return { text: renderCallees(r), data: r, reparsed };
  }
  return { degraded: true, reason: `unknown symbol subcommand '${sub}' (use index|find|enclosing|methods|callers|callees)` };
}

/** LRU-ish cleanup: drop symbol caches not touched in `maxAgeMs`. Returns count removed. */
export function pruneSymbolCaches(paths: RouterPaths, nowMs: number, maxAgeMs: number): number {
  if (!existsSync(paths.symbolsDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(paths.symbolsDir)) {
    if (!name.endsWith('.json')) continue;
    const p = resolve(paths.symbolsDir, name);
    try {
      if (nowMs - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
