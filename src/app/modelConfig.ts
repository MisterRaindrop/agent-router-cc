// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { ModelConfig, ModelSpec, WorkerPolicy } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';

// The models router launches. A bundled default ships in this file so the config always exists;
// a repo may override it with `.router/models.yaml`. Nothing here is ever auto-modified.
//
// There used to be a weak / strong / critical tier per executor, and a quota balancer choosing
// between codex and claude for each dispatch. Both went with the executor model in 0.15.0: the
// main session writes the code, and codex is launched only when the user names it. What is left
// is one default for that writer and the reviewer chain.
//
// The writer defaults to what dispatch had converged on by the end: the codex `critical` row,
// `gpt-5.6-sol` at `xhigh`. The pin always carries the effort explicitly, because an omitted
// effort silently falls back to the provider default.
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  writer: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  // design-review / review: strongest + independent (non-Claude first); fall to a same-strength
  // Claude reviewer if codex is unavailable. Review runs in the background, so its effort buys
  // judgment rather than blocking the human -- but a reviewer that thinks for fifteen minutes
  // also slows the round trip it exists to serve, and review rewards breadth over deep
  // single-chain deduction. `high` is the default; `xhigh` or `max` is an explicit opt-in.
  review: [
    { kind: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    { kind: 'claude', model: 'opus', effort: 'high' },
  ],
};

/** Absolute path to the optional per-repo override file. */
export function modelsYamlPath(paths: RouterPaths): string {
  return join(paths.root, 'models.yaml');
}

function isSpec(v: unknown): v is ModelSpec {
  return typeof v === 'object' && v !== null && typeof (v as ModelSpec).model === 'string';
}

function spec(v: ModelSpec): ModelSpec {
  return { model: v.model, ...(v.effort ? { effort: v.effort } : {}) };
}

/**
 * The resolved config = bundled default, overlaid with `.router/models.yaml` if present. A
 * missing or unreadable file falls back to the default, so launching never needs a hand-written
 * file to work.
 *
 * A models.yaml written for the tiered config is still honoured where it can be: with no
 * `writer:` key, its `codex.critical` row is the writer, since that is the row dispatch used.
 */
export function loadModelConfig(paths: RouterPaths): ModelConfig {
  const cfg: ModelConfig = JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG)) as ModelConfig;
  let raw: unknown;
  try {
    raw = load(readFileSync(modelsYamlPath(paths), 'utf8'), { schema: JSON_SCHEMA });
  } catch {
    return cfg;
  }
  if (typeof raw !== 'object' || raw === null) return cfg;
  const o = raw as Record<string, unknown>;

  const legacy = (o.codex as Record<string, unknown> | undefined)?.critical;
  if (isSpec(o.writer)) cfg.writer = spec(o.writer);
  else if (isSpec(legacy)) cfg.writer = spec(legacy);

  if (Array.isArray(o.review)) {
    const chain = o.review.filter(
      (r): r is WorkerPolicy => typeof r === 'object' && r !== null && (r as WorkerPolicy).kind !== undefined,
    );
    if (chain.length > 0) cfg.review = chain;
  }
  return cfg;
}
