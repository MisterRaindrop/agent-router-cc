// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import type { MetricRecord, RunResult } from '../domain/types.ts';
import type { RouterPaths } from './paths.ts';
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
