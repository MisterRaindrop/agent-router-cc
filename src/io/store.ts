// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type {
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
