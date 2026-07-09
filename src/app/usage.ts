// Parse token usage from a codex `exec --json` event stream (captured in the
// worker log). codex emits one `turn.completed` event per turn carrying a
// `usage` object; we sum across turns. Cost is derived only if per-MTok prices
// are configured (ChatGPT-auth runs have no per-token price → cost stays null).

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export function parseCodexUsage(logText: string): Usage | null {
  let found = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as { type?: string; usage?: Record<string, unknown> };
    if (rec.type === 'turn.completed' && rec.usage) {
      found = true;
      input += num(rec.usage.input_tokens);
      output += num(rec.usage.output_tokens);
      cached += num(rec.usage.cached_input_tokens);
    }
  }
  return found ? { input, output, cached } : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Extract the model slug from the codex --json stream, if any event reports one.
 * The current codex exec --json does NOT emit a model field, so this returns null
 * today; it future-proofs against a codex version that adds one (e.g. on
 * thread.started or turn.started). When null, callers fall back to the model
 * pinned in policy (`worker.model`).
 */
export function parseCodexModel(logText: string): string | null {
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as { model?: unknown; thread?: { model?: unknown }; turn?: { model?: unknown } };
    const m = rec.model ?? rec.thread?.model ?? rec.turn?.model;
    if (typeof m === 'string' && m !== '') return m;
  }
  return null;
}

/**
 * Estimated USD cost from token counts, if prices are configured via
 * ROUTER_PRICE_INPUT_PER_MTOK / ROUTER_PRICE_OUTPUT_PER_MTOK (dollars per
 * million tokens). Returns null when no prices are set.
 */
export function estimateCostUsd(usage: Usage, env: NodeJS.ProcessEnv): number | null {
  const pin = parseFloat(env.ROUTER_PRICE_INPUT_PER_MTOK ?? '');
  const pout = parseFloat(env.ROUTER_PRICE_OUTPUT_PER_MTOK ?? '');
  if (!Number.isFinite(pin) && !Number.isFinite(pout)) return null;
  const inCost = (Number.isFinite(pin) ? pin : 0) * (usage.input / 1_000_000);
  const outCost = (Number.isFinite(pout) ? pout : 0) * (usage.output / 1_000_000);
  return inCost + outCost;
}
