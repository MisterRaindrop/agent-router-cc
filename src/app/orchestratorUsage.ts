// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deriveCost } from '../core/pricing.ts';
import type { MetricRecord } from '../domain/types.ts';
import type { Clock } from '../io/clock.ts';
import type { RouterPaths } from '../io/paths.ts';
import * as store from '../io/store.ts';
import { sumMainModelUsageSince } from '../io/transcript.ts';

export interface OrchestratorUsageOptions {
  planId: string;
  sinceIso: string;
  untilIso?: string;
  transcriptPath?: string;
  projectsDir?: string;
  model: string;
}

export type OrchestratorUsageResult =
  | { recorded: false; reason: 'no transcript' | 'no matching main-model turns' }
  | {
      recorded: true;
      inputTokens: number;
      outputTokens: number;
      turns: number;
      cost_usd: number | null;
    };

function newestTranscript(projectsDir: string): string | undefined {
  let newest: { path: string; name: string; mtimeMs: number } | undefined;
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(projectsDir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (
      newest === undefined ||
      mtimeMs > newest.mtimeMs ||
      (mtimeMs === newest.mtimeMs && entry.name > newest.name)
    ) {
      newest = { path, name: entry.name, mtimeMs };
    }
  }
  return newest?.path;
}

function resolveTranscript(paths: RouterPaths, opts: OrchestratorUsageOptions): string | undefined {
  if (opts.transcriptPath !== undefined) return opts.transcriptPath;
  const projectKey = paths.repoRoot.replaceAll('/', '-');
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects', projectKey);
  return newestTranscript(projectsDir);
}

export function recordOrchestratorUsage(
  paths: RouterPaths,
  clock: Clock,
  opts: OrchestratorUsageOptions,
): OrchestratorUsageResult {
  const transcript = resolveTranscript(paths, opts);
  if (transcript === undefined) return { recorded: false, reason: 'no transcript' };

  const until = opts.untilIso ?? clock.nowIso();
  const totals = sumMainModelUsageSince(transcript, opts.sinceIso, opts.model, until);
  if (totals.turns === 0) return { recorded: false, reason: 'no matching main-model turns' };

  const cost_usd = deriveCost(opts.model, totals.inputTokens, totals.outputTokens);
  const record: MetricRecord = {
    ts: clock.nowIso(),
    task_id: `${opts.planId}/orchestrator`,
    plan_id: opts.planId,
    role: 'orchestrator',
    run_id: 'orchestrator',
    attempt_number: 1,
    model: opts.model,
    exit_class: 'ok',
    verifier_result: null,
    first_pass: true,
    tokens_input: totals.inputTokens,
    tokens_output: totals.outputTokens,
    cost_usd,
    wall_seconds: Math.max(0, Math.round((Date.parse(until) - Date.parse(opts.sinceIso)) / 1000)),
    escalated: false,
    env_error: false,
  };
  store.appendMetric(paths, record);
  return { recorded: true, ...totals, cost_usd };
}
