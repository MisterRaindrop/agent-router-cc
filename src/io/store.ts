// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import type { MetricRecord, RunResult } from '../domain/types.ts';
import { runBranch, type RouterPaths } from './paths.ts';
import { writeJsonAtomic } from './atomicWrite.ts';
import { appendJsonl } from './jsonl.ts';

// Typed disk access for the .router tree. JSON docs are written atomically;
// metrics are append-only JSONL. This module holds NO policy - it just reads
// and writes shapes.

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// -- run artifacts --
/**
 * The task's run record, falling back to the pre-fold `runs/run-001/` location.
 *
 * The fallback is read-only and deliberate: upgrading router must not make an existing task's
 * result vanish, and `land` / `result` / `usage` all read this.
 */
export function readResult(p: RouterPaths, id: string): RunResult | null {
  const current = readJson<RunResult>(p.resultJson(id));
  if (current !== null) return current;
  const legacy = readJson<RunResult & { run_id?: string }>(p.legacyResultJson(id));
  if (legacy === null) return null;
  // Normalize the one field the pre-fold schema lacks. A record written before the fold has no
  // `branch`, and every consumer -- land, resume, the queue gate, list -- falls back to
  // `router/<id>`. But the branch that record's run actually created was `router/<id>/<run_id>`,
  // so a task that was PASSED and waiting to be merged before the upgrade could not be merged
  // after it: `land` reported "not something we can merge" while the real branch sat right there.
  //
  // Read-only compatibility that cannot read the thing it exists for is not compatibility, so
  // the derivation happens here, once, rather than in each of the four consumers.
  if (legacy.branch === undefined && typeof legacy.run_id === 'string' && legacy.run_id !== '') {
    return { ...legacy, branch: runBranch(id, legacy.run_id) };
  }
  return legacy;
}
export function writeResult(p: RouterPaths, id: string, result: RunResult): void {
  writeJsonAtomic(p.resultJson(id), result);
}

// -- metrics --
export function appendMetric(p: RouterPaths, record: MetricRecord): void {
  appendJsonl(p.metrics, record);
}
