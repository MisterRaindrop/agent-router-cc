// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROUTER_DIR } from '../domain/constants.ts';

// All layout knowledge for a target project's `.router/` tree lives here.
//
// A run's files sit directly in `tasks/<id>/`. They used to sit in `tasks/<id>/runs/run-001/`,
// which was a directory level over a constant: dispatch has been one attempt per task since
// the synchronous model landed, so the run dimension only ever held `run-001`. The old path
// stays readable (see legacyResultJson) so upgrading does not lose a task's history.

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
  heartbeat(id: string): string;
  runStatus(id: string): string;
  resultJson(id: string): string;
  diffPatch(id: string): string;
  delivery(id: string): string;
  workerLog(id: string): string;
  gateLog(id: string): string;
  /**
   * Where a pre-fold run wrote the same file: `tasks/<id>/runs/run-001/...`.
   *
   * Read-only, and kept only so records written before the fold are still readable -- a task
   * whose history silently disappears at upgrade is worse than an extra lookup.
   */
  legacyResultJson(id: string): string;
  /** @deprecated no worktree is created for an executor; see DEPRECATIONS.md. */
  worktree(id: string, runId: string): string;
}

/** Zero-padded run id, e.g. runId(1) === "run-001". @deprecated the run dimension is folded. */
export function runId(n: number): string {
  return `run-${String(n).padStart(3, '0')}`;
}

/**
 * Branch name for a run, e.g. "router/<id>/run-001".
 *
 * @deprecated The run segment named a constant; use taskBranch(). Kept for the rollback window
 * in DEPRECATIONS.md.
 */
export function runBranch(id: string, run: string): string {
  return `router/${id}/${run}`;
}

/**
 * The branch a task is developed on, e.g. "router/<id>".
 *
 * No run segment: `dispatch` has been one attempt per task since the sync model landed, so the
 * run dimension was a naming layer over a constant. The `router/` prefix is load-bearing rather
 * than decorative -- destructive steps assert the current branch starts with it before they
 * are allowed to reset anything, which is what keeps a reset off the user's own branch.
 */
export function taskBranch(id: string): string {
  return `router/${id}`;
}

/** Path to a branch's loose ref file. Reading its mtime is a cheap liveness probe. */
export function branchRefPath(repoRoot: string, branch: string): string {
  return join(repoRoot, '.git', 'refs', 'heads', ...branch.split('/'));
}

export function routerPaths(routerDir: string): RouterPaths {
  const root = resolve(routerDir);
  const tasksDir = join(root, 'tasks');
  const taskDir = (id: string) => join(tasksDir, id);
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
    heartbeat: (id) => join(taskDir(id), 'heartbeat'),
    runStatus: (id) => join(taskDir(id), 'status.json'),
    resultJson: (id) => join(taskDir(id), 'result.json'),
    diffPatch: (id) => join(taskDir(id), 'diff.patch'),
    delivery: (id) => join(taskDir(id), 'DELIVERY.md'),
    workerLog: (id) => join(taskDir(id), 'logs', 'worker.log'),
    gateLog: (id) => join(taskDir(id), 'logs', 'gate.log'),
    legacyResultJson: (id) => join(taskDir(id), 'runs', 'run-001', 'result.json'),
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
