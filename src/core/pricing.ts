// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Project-maintained price table (USD per million tokens). Costs derived from it
// are ESTIMATES at public list prices; real bills differ (discounts, and plan
// auth isn't billed per token at all). Update from provider pricing pages
// periodically. Unknown model -> null, and the caller shows tokens only, never a
// fake $0.00.

export interface ModelPrice {
  inPerMTok: number;
  outPerMTok: number;
}

// Matched by case-insensitive substring of the model slug; longest key wins so
// e.g. "gpt-5-mini" beats "gpt-5". Keep entries broad (slugs carry date suffixes).
const TABLE: ReadonlyArray<readonly [string, ModelPrice]> = [
  // Anthropic (Claude)
  ['opus', { inPerMTok: 5, outPerMTok: 25 }],
  ['sonnet', { inPerMTok: 3, outPerMTok: 15 }],
  ['haiku', { inPerMTok: 1, outPerMTok: 5 }],
  // OpenAI (Codex / GPT)
  ['gpt-5-nano', { inPerMTok: 0.05, outPerMTok: 0.4 }],
  ['gpt-5-mini', { inPerMTok: 0.25, outPerMTok: 2 }],
  ['gpt-5-codex', { inPerMTok: 1.25, outPerMTok: 10 }],
  ['gpt-5', { inPerMTok: 1.25, outPerMTok: 10 }],
];

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const [key, price] of TABLE) {
    if (m.includes(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/** Derive a cost estimate (USD) from token counts, or null if the model is unknown. */
export function deriveCost(model: string | null | undefined, tokensIn: number, tokensOut: number): number | null {
  const p = priceFor(model);
  if (p === null) return null;
  return (tokensIn / 1e6) * p.inPerMTok + (tokensOut / 1e6) * p.outPerMTok;
}

// The strong-model baseline used to estimate savings: "what this dispatch would
// have cost if the strong orchestrator model had done it instead". Opus is the most
// expensive tier, so this is the upper-plausible-bound baseline. See deriveBaselineCost.
export const STRONG_BASELINE_MODEL = 'opus';

/** Cost of these token counts if priced at the strong-model baseline (always known). */
export function deriveBaselineCost(tokensIn: number, tokensOut: number): number {
  return deriveCost(STRONG_BASELINE_MODEL, tokensIn, tokensOut) ?? 0;
}
