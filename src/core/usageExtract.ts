// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Best-effort extraction of plan rate-limit usage from a Claude Code statusline
// payload (PURE). The exact `rate_limits` shape on statusline stdin is not fully
// documented, so this is defensive: it searches for a rate_limits object and tries a
// few plausible field forms, returning null when nothing recognizable is present (the
// caller then falls back to codex quota + the reactive 429). Shape returned matches
// what io/quota.readClaudeQuota consumes.
export interface UsageSnapshot {
  used_percent: number;
  resets_at: number | null;
  reached: boolean;
}

function num(x: unknown): number | null {
  return typeof x === 'number' ? x : null;
}

function findRateLimits(x: unknown): Record<string, unknown> | null {
  if (x === null || typeof x !== 'object') return null;
  const obj = x as Record<string, unknown>;
  if (obj['rate_limits'] && typeof obj['rate_limits'] === 'object') return obj['rate_limits'] as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    const r = findRateLimits(obj[k]);
    if (r) return r;
  }
  return null;
}

function pct(o: Record<string, unknown>): number | null {
  if (typeof o['used_percent'] === 'number') return o['used_percent'];
  if (typeof o['used_percentage'] === 'number') return o['used_percentage'];
  if (typeof o['remaining_percentage'] === 'number') return 100 - (o['remaining_percentage'] as number);
  return null;
}

export function extractUsage(root: unknown): UsageSnapshot | null {
  const rl = findRateLimits(root);
  const candidates: Record<string, unknown>[] = [];
  if (rl) {
    candidates.push(rl);
    if (rl['primary'] && typeof rl['primary'] === 'object') candidates.push({ ...rl, ...(rl['primary'] as object) });
  }
  if (root !== null && typeof root === 'object') candidates.push(root as Record<string, unknown>);
  for (const o of candidates) {
    const up = pct(o);
    if (up !== null) {
      return { used_percent: up, resets_at: num(o['resets_at']), reached: o['rate_limit_reached_type'] != null || up >= 100 };
    }
  }
  return null;
}
