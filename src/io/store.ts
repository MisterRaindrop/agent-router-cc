// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovalRecord,
  BaselineRecord,
  EventRecord,
  Lease,
  MetricRecord,
  Registry,
  RunResult,
  StateFile,
} from '../domain/types.ts';
import type { RouterPaths } from './paths.ts';
import { writeJsonAtomic } from './atomicWrite.ts';
import { appendJsonl, readJsonl } from './jsonl.ts';

// Typed disk access for the .router tree. JSON docs are written atomically;
// events/metrics are append-only JSONL. This module holds NO policy - it just
// reads and writes shapes.

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// -- task state (projection) --
export function readState(p: RouterPaths, id: string): StateFile | null {
  return readJson<StateFile>(p.stateFile(id));
}
export function writeState(p: RouterPaths, id: string, state: StateFile): void {
  writeJsonAtomic(p.stateFile(id), state);
}

// -- events (source of truth) --
export function readEvents(p: RouterPaths, id: string): EventRecord[] {
  return readJsonl<EventRecord>(p.eventsFile(id));
}
export function appendEvent(p: RouterPaths, id: string, event: EventRecord): void {
  appendJsonl(p.eventsFile(id), event);
}

// -- registry (rebuildable index) --
export function readRegistry(p: RouterPaths): Registry | null {
  return readJson<Registry>(p.registry);
}
export function writeRegistry(p: RouterPaths, registry: Registry): void {
  writeJsonAtomic(p.registry, registry);
}

// -- run artifacts --
export function readLease(p: RouterPaths, id: string, run: string): Lease | null {
  return readJson<Lease>(p.lease(id, run));
}
export function writeLease(p: RouterPaths, id: string, run: string, lease: Lease): void {
  writeJsonAtomic(p.lease(id, run), lease);
}
export function readResult(p: RouterPaths, id: string, run: string): RunResult | null {
  return readJson<RunResult>(p.resultJson(id, run));
}
export function writeResult(p: RouterPaths, id: string, run: string, result: RunResult): void {
  writeJsonAtomic(p.resultJson(id, run), result);
}

// -- metrics --
export function appendMetric(p: RouterPaths, record: MetricRecord): void {
  appendJsonl(p.metrics, record);
}
export function readMetrics(p: RouterPaths): MetricRecord[] {
  return readJsonl<MetricRecord>(p.metrics);
}

/** Rewrite metrics.jsonl with exactly `records` (used by `router gc` rotation). */
export function overwriteMetrics(p: RouterPaths, records: readonly MetricRecord[]): void {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(p.metrics, text.length > 0 ? `${text}\n` : '');
}
/** Write the archived (rotated-out) metric records to metrics.jsonl.1. */
export function writeMetricsArchive(p: RouterPaths, records: readonly MetricRecord[]): void {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(p.metricsArchive, text.length > 0 ? `${text}\n` : '');
}

// -- approval gate (recorded when a high-risk task is approved for merge) --
export function readApproval(p: RouterPaths, id: string): ApprovalRecord | null {
  return readJson<ApprovalRecord>(p.approval(id));
}
export function writeApproval(p: RouterPaths, id: string, record: ApprovalRecord): void {
  writeJsonAtomic(p.approval(id), record);
}

// ── baseline ledger (recorded Opus-direct measurements) ──
export function appendBaseline(p: RouterPaths, record: BaselineRecord): void {
  appendJsonl(p.baseline, record);
}
export function readBaseline(p: RouterPaths): BaselineRecord[] {
  return readJsonl<BaselineRecord>(p.baseline);
}

// -- discovery --
export function listTaskIds(p: RouterPaths): string[] {
  if (!existsSync(p.tasksDir)) return [];
  return readdirSync(p.tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function listRunIds(p: RouterPaths, id: string): string[] {
  const dir = p.runsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^run-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Run ids that still have a worktree directory under .router/worktrees/<id>/. */
export function listWorktreeRuns(p: RouterPaths, id: string): string[] {
  const dir = join(p.worktreesDir, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^run-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Total size in bytes of a file or directory tree (0 if absent). */
export function pathSizeBytes(path: string): number {
  let total = 0;
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) total += pathSizeBytes(join(path, name));
  } else {
    total += st.size;
  }
  return total;
}

/** Remove the empty .router/worktrees/<id>/ parent dir once its runs are gone. */
export function removeEmptyWorktreeParent(p: RouterPaths, id: string): void {
  const dir = join(p.worktreesDir, id);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}
