// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Parse token usage and model from a codex `exec --json` event stream (captured
// in the worker log). codex emits one `turn.completed` event per turn carrying a
// `usage` object; we sum across turns. Cost, when present, is the provider-reported
// value (claude's `total_cost_usd`); a ChatGPT-plan run reports none.

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export interface ParsedLog {
  usage: Usage | null;
  model: string | null;
  costUsd?: number | null; // provider-reported cost (claude), if any; else derived from price
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

/**
 * Parse the claude CLI `--output-format stream-json` stream: the final
 * `type:"result"` event carries `usage` (input/output tokens) and
 * `total_cost_usd` (an API-equivalent cost, present even on a plan).
 */
export function parseClaudeLog(logText: string): ParsedLog {
  let usage: Usage | null = null;
  let costUsd: number | null = null;
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
      total_cost_usd?: unknown;
      model?: unknown;
    };
    if (rec.type === 'result' && rec.usage) {
      usage = { input: num(rec.usage.input_tokens), output: num(rec.usage.output_tokens), cached: num(rec.usage.cache_read_input_tokens) };
      if (typeof rec.total_cost_usd === 'number') costUsd = rec.total_cost_usd;
    }
    if (model === null && typeof rec.model === 'string' && rec.model !== '') model = rec.model;
  }
  return { usage, model, costUsd };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
