// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorQuota } from '../domain/types.ts';

// Read each executor's REAL remaining quota from its local usage source. codex writes
// rate limits into ~/.codex/sessions/**/*.jsonl; claude's plan rate_limits arrive on
// Claude Code statusline stdin and are snapshotted to .router/usage.json by the router
// statusline. Either returns null when the source is unavailable -- the caller then
// falls back to chain order + the reactive 429 switch.

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}
interface CodexRateLimits {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  rate_limit_reached_type?: string | null;
}

function walkJsonl(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) out = out.concat(walkJsonl(p));
    else if (name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function findRateLimits(x: unknown): CodexRateLimits | null {
  if (x === null || typeof x !== 'object') return null;
  const obj = x as Record<string, unknown>;
  if (obj['rate_limits'] && typeof obj['rate_limits'] === 'object') return obj['rate_limits'] as CodexRateLimits;
  for (const k of Object.keys(obj)) {
    const r = findRateLimits(obj[k]);
    if (r) return r;
  }
  return null;
}

/** codex remaining quota from the newest ~/.codex session file; null if none. */
export function readCodexQuota(sessionsDir: string): ExecutorQuota | null {
  const files = walkJsonl(sessionsDir).sort(); // timestamped names sort chronologically
  const newest = files.at(-1);
  if (newest === undefined) return null;
  let lines: string[];
  try {
    lines = readFileSync(newest, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!;
    if (!ln.includes('rate_limits')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ln);
    } catch {
      continue;
    }
    const rl = findRateLimits(parsed);
    if (rl === null) continue;
    const windows = [rl.primary, rl.secondary].filter((w): w is CodexWindow => w != null);
    if (windows.length === 0) continue;
    let binding = windows[0]!;
    for (const w of windows.slice(1)) if ((w.used_percent ?? 0) > (binding.used_percent ?? 0)) binding = w;
    const used = binding.used_percent ?? 0;
    return {
      kind: 'codex',
      used_percent: used,
      resets_at: binding.resets_at ?? null,
      available: (rl.rate_limit_reached_type ?? null) === null && used < 100,
    };
  }
  return null;
}

/** claude remaining quota from the statusline snapshot; null if absent/invalid. */
export function readClaudeQuota(usageJsonPath: string): ExecutorQuota | null {
  if (!existsSync(usageJsonPath)) return null;
  let o: { used_percent?: unknown; resets_at?: unknown; reached?: unknown };
  try {
    o = JSON.parse(readFileSync(usageJsonPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof o.used_percent !== 'number') return null;
  return {
    kind: 'claude',
    used_percent: o.used_percent,
    resets_at: typeof o.resets_at === 'number' ? o.resets_at : null,
    available: o.reached !== true && o.used_percent < 100,
  };
}
