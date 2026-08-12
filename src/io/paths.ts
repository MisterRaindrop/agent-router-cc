// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROUTER_DIR } from '../domain/constants.ts';

// All layout knowledge for a target project's `.router/` tree lives here.
// Returns absolute paths; run-NNN formatting is centralized in runId().

export interface RouterPaths {
  readonly root: string; // absolute path to the .router dir
  readonly repoRoot: string; // the git repo root (parent of .router)
  readonly metrics: string;
  readonly tasksDir: string;
  readonly worktreesDir: string;
  readonly symbolsDir: string; // code-intelligence symbol caches (gitignored, per-repo)
  readonly symbolLatest: string; // pointer file: hash of the most recently built index
  gateLock(): string;
  /** Per-plan directory. Plan artifacts are namespaced so two plans reviewed at once in one
   * repo cannot clobber each other -- and, more sharply, so a reviewer told to read the plan
   * from disk cannot silently be handed a different one. `plan_id` is schema-constrained to a
   * path-safe shape for exactly this reason. */
  planDir(planId: string): string;
  planMd(planId: string): string;
  specCritique(planId: string, round: number): string;
  specDecisions(planId: string): string;
  specLock(planId: string): string;
  symbolCache(hash: string): string;
  taskDir(id: string): string;
  taskYaml(id: string): string;
  contractMd(id: string): string;
  taskContext(id: string): string;
  runsDir(id: string): string;
  heartbeat(id: string, runId: string): string;
  runStatus(id: string, runId: string): string;
  resultJson(id: string, runId: string): string;
  diffPatch(id: string, runId: string): string;
  delivery(id: string, runId: string): string;
  workerLog(id: string, runId: string): string;
  gateLog(id: string, runId: string): string;
  worktree(id: string, runId: string): string;
}

/** Zero-padded run id, e.g. runId(1) === "run-001". */
export function runId(n: number): string {
  return `run-${String(n).padStart(3, '0')}`;
}

/** Branch name for a run, e.g. "router/<id>/run-001". */
export function runBranch(id: string, run: string): string {
  return `router/${id}/${run}`;
}

export function routerPaths(routerDir: string): RouterPaths {
  const root = resolve(routerDir);
  const tasksDir = join(root, 'tasks');
  const taskDir = (id: string) => join(tasksDir, id);
  const runDir = (id: string, run: string) => join(taskDir(id), 'runs', run);
  return {
    root,
    repoRoot: dirname(root),
    metrics: join(root, 'metrics.jsonl'),
    tasksDir,
    worktreesDir: join(root, 'worktrees'),
    symbolsDir: join(root, 'symbols'),
    symbolLatest: join(root, 'symbols', 'latest'),
    gateLock: () => join(root, 'gate.lock'),
    planDir: (planId) => join(root, 'plans', planId),
    planMd: (planId) => join(root, 'plans', planId, 'PLAN.md'),
    specCritique: (planId, round) => join(root, 'plans', planId, `critique-${round}.md`),
    specDecisions: (planId) => join(root, 'plans', planId, 'DECISIONS.md'),
    specLock: (planId) => join(root, 'plans', planId, 'spec.lock'),
    symbolCache: (hash: string) => join(root, 'symbols', `${hash}.json`),
    taskDir,
    taskYaml: (id) => join(taskDir(id), 'task.yaml'),
    contractMd: (id) => join(taskDir(id), 'TASK_CONTRACT.md'),
    taskContext: (id) => join(taskDir(id), 'TASK_CONTEXT.md'),
    runsDir: (id) => join(taskDir(id), 'runs'),
    heartbeat: (id, run) => join(runDir(id, run), 'heartbeat'),
    runStatus: (id, run) => join(runDir(id, run), 'status.json'),
    resultJson: (id, run) => join(runDir(id, run), 'result.json'),
    diffPatch: (id, run) => join(runDir(id, run), 'diff.patch'),
    delivery: (id, run) => join(runDir(id, run), 'DELIVERY.md'),
    workerLog: (id, run) => join(runDir(id, run), 'logs', 'worker.log'),
    gateLog: (id, run) => join(runDir(id, run), 'logs', 'gate.log'),
    worktree: (id, run) => join(root, 'worktrees', id, run),
  };
}

/**
 * Walk up from `startDir` looking for an existing `.router/` directory.
 * Returns its absolute path, or null if none is found up to the filesystem root.
 */
export function findRouterDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ROUTER_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
