// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { MetricRecord, TaskState } from '../domain/types.ts';
import { isTerminal } from './stateMachine.ts';

// Garbage-collection DECISIONS. PURE: given metric records / a task listing (with
// timestamps and states supplied by io), decide what to keep vs. drop. The io
// layer performs the actual file removal. The critical safety invariant lives
// here: a run worktree is only ever removed for a TERMINAL task (MERGED /
// CANCELLED / ABANDONED); anything RUNNING/QUEUED/etc. is left untouched.

// -- metrics.jsonl retention -------------------------------------------------

export interface RetentionOpts {
  keepLast?: number; // keep at most the most-recent N records
  maxAgeMs?: number; // drop records older than this (needs nowMs)
  nowMs?: number; // reference "now" in epoch ms (injected; core reads no clock)
}

export interface RetentionPlan {
  keep: MetricRecord[];
  dropped: MetricRecord[];
}

/**
 * Partition metric records into keep/dropped. Age filter runs first (a record
 * with an unparseable ts is kept, never silently dropped), then the count cap
 * keeps the most-recent N. Order is preserved. PURE.
 */
export function planMetricRetention(
  records: readonly MetricRecord[],
  opts: RetentionOpts,
): RetentionPlan {
  let keep = [...records];

  if (opts.maxAgeMs !== undefined && opts.nowMs !== undefined) {
    const cutoff = opts.nowMs - opts.maxAgeMs;
    keep = keep.filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isNaN(t) ? true : t >= cutoff;
    });
  }

  if (opts.keepLast !== undefined && keep.length > opts.keepLast) {
    keep = keep.slice(keep.length - opts.keepLast);
  }

  const keepSet = new Set(keep);
  const dropped = records.filter((r) => !keepSet.has(r));
  return { keep, dropped };
}

// -- run worktree / artifact GC ----------------------------------------------

export interface TaskGcInput {
  id: string;
  state: TaskState;
  worktrees: readonly string[]; // run ids that still have a worktree dir on disk
}

export interface GcAction {
  taskId: string;
  runId: string;
}

export interface GcPlan {
  remove: GcAction[]; // worktrees safe to delete (terminal tasks only)
  skipped: { taskId: string; state: TaskState; worktrees: number }[]; // left alone
}

/**
 * Decide which run worktrees may be removed. Only terminal tasks are eligible;
 * a non-terminal task with worktrees is reported as skipped so `gc` can explain
 * why it kept them. PURE.
 */
export function planRunGc(tasks: readonly TaskGcInput[]): GcPlan {
  const remove: GcAction[] = [];
  const skipped: GcPlan['skipped'] = [];
  for (const t of tasks) {
    if (isTerminal(t.state)) {
      for (const runId of t.worktrees) remove.push({ taskId: t.id, runId });
    } else if (t.worktrees.length > 0) {
      skipped.push({ taskId: t.id, state: t.state, worktrees: t.worktrees.length });
    }
  }
  return { remove, skipped };
}
