// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Parse token usage and model from a codex `exec --json` event stream (captured
// in the worker log), and derive cost. codex emits one `turn.completed` event per
// turn carrying a `usage` object; we sum across turns. Cost is per-model when
// `policy.pricing` is set, else a single ROUTER_PRICE_* env fallback, else null
// (a ChatGPT-plan run has no per-token price).

import type { Policy } from '../domain/types.ts';

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export interface ParsedLog {
  usage: Usage | null;
  model: string | null;
}

/** Single pass over the log: token usage (summed) and model slug (if the stream reports one). */
export function parseCodexLog(logText: string): ParsedLog {
  let found = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  let model: string | null = null;
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as {
      type?: string;
      usage?: Record<string, unknown>;
      model?: unknown;
      thread?: { model?: unknown };
      turn?: { model?: unknown };
    };
    if (rec.type === 'turn.completed' && rec.usage) {
      found = true;
      input += num(rec.usage.input_tokens);
      output += num(rec.usage.output_tokens);
      cached += num(rec.usage.cached_input_tokens);
    }
    if (model === null) {
      const m = rec.model ?? rec.thread?.model ?? rec.turn?.model;
      if (typeof m === 'string' && m !== '') model = m;
    }
  }
  return { usage: found ? { input, output, cached } : null, model };
}

// Kept as thin wrappers for focused unit tests; the worker uses parseCodexLog once.
export function parseCodexUsage(logText: string): Usage | null {
  return parseCodexLog(logText).usage;
}
export function parseCodexModel(logText: string): string | null {
  return parseCodexLog(logText).model;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface Price {
  input_per_mtok?: number;
  output_per_mtok?: number;
}

/**
 * Resolve the per-token price for a run's model: policy.pricing[model], else
 * policy.pricing.default, else the ROUTER_PRICE_* env fallback. Returns null when
 * nothing is configured (plan mode -> cost stays null).
 */
export function resolvePrice(
  policy: Policy,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): Price | null {
  const table = policy.pricing;
  if (table !== undefined) {
    const hit = (model !== undefined ? table[model] : undefined) ?? table['default'];
    if (hit !== undefined) return hit;
  }
  const pin = parseFloat(env.ROUTER_PRICE_INPUT_PER_MTOK ?? '');
  const pout = parseFloat(env.ROUTER_PRICE_OUTPUT_PER_MTOK ?? '');
  if (!Number.isFinite(pin) && !Number.isFinite(pout)) return null;
  return {
    ...(Number.isFinite(pin) ? { input_per_mtok: pin } : {}),
    ...(Number.isFinite(pout) ? { output_per_mtok: pout } : {}),
  };
}

/** USD cost from token counts at a resolved price. Null when no price. */
export function estimateCostUsd(usage: Usage, price: Price | null): number | null {
  if (price === null) return null;
  const pin = price.input_per_mtok ?? 0;
  const pout = price.output_per_mtok ?? 0;
  if (pin === 0 && pout === 0) return null;
  return pin * (usage.input / 1_000_000) + pout * (usage.output / 1_000_000);
}
