// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { ModelSpec, ModelTier, ModelTierConfig, WorkerPolicy } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';

// The model menu for tiered routing. A bundled default ships in this file so the
// config always exists (routing never needs a hand-written file to work). A repo
// may override it with `.router/models.yaml`; overrides are shallow-merged per
// (executor, tier) slot, and `review` replaces the whole chain if present.
//
// Slugs are the standard codex/claude subscription models. They may go stale as a
// provider updates its lineup; a dispatch that a CLI rejects surfaces a warning
// (see core/exitTaxonomy.detectModelMismatch) telling the user to edit models.yaml.
// Nothing here is ever auto-modified.

export const DEFAULT_MODEL_CONFIG: ModelTierConfig = {
  codex: {
    weak: { model: 'gpt-5.6-terra', effort: 'xhigh' },
    strong: { model: 'gpt-5.6-sol', effort: 'max' },
  },
  claude: {
    weak: { model: 'haiku', effort: 'xhigh' },
    strong: { model: 'opus', effort: 'xhigh' },
  },
  // spec/review: strongest + independent (non-Claude first); fall to a same-strength
  // Claude reviewer if codex is unavailable/out of quota.
  review: [
    { kind: 'codex', model: 'gpt-5.6-sol', effort: 'max' },
    { kind: 'claude', model: 'opus', effort: 'xhigh' },
  ],
};

/** Absolute path to the optional per-repo override file. */
export function modelsYamlPath(paths: RouterPaths): string {
  return join(paths.root, 'models.yaml');
}

function isSpec(v: unknown): v is ModelSpec {
  return typeof v === 'object' && v !== null && typeof (v as ModelSpec).model === 'string';
}

/** Deep-clone the default so callers never mutate the shared constant. */
function cloneDefault(): ModelTierConfig {
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG)) as ModelTierConfig;
}

/**
 * The resolved model config = bundled default, overlaid with `.router/models.yaml`
 * if present. Missing file or unreadable/partial override falls back to the default
 * (per slot), so routing always has a complete config to work from.
 */
export function loadModelConfig(paths: RouterPaths): ModelTierConfig {
  const cfg = cloneDefault();
  let raw: unknown;
  try {
    raw = load(readFileSync(modelsYamlPath(paths), 'utf8'), { schema: JSON_SCHEMA });
  } catch {
    return cfg; // no file (or parse error) -> bundled default
  }
  if (typeof raw !== 'object' || raw === null) return cfg;
  const o = raw as Record<string, unknown>;

  for (const kind of ['codex', 'claude'] as const) {
    const section = o[kind];
    if (typeof section === 'object' && section !== null) {
      for (const tier of ['weak', 'strong'] as const) {
        const spec = (section as Record<string, unknown>)[tier];
        if (isSpec(spec)) cfg[kind][tier] = { model: spec.model, ...(spec.effort ? { effort: spec.effort } : {}) };
      }
    }
  }
  if (Array.isArray(o.review)) {
    const chain = o.review.filter(
      (r): r is WorkerPolicy =>
        typeof r === 'object' && r !== null && (r as WorkerPolicy).kind !== undefined,
    );
    if (chain.length > 0) cfg.review = chain;
  }
  return cfg;
}

/**
 * Candidate executors for a dispatch task at a given tier: one per executor,
 * each carrying that tier's model + effort. Router then picks by quota.
 */
export function tierWorkers(cfg: ModelTierConfig, tier: ModelTier): WorkerPolicy[] {
  return (['codex', 'claude'] as const).map((kind) => {
    const spec = cfg[kind][tier];
    return { kind, model: spec.model, ...(spec.effort ? { effort: spec.effort } : {}) };
  });
}
