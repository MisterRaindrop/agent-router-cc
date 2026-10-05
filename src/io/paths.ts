// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROUTER_DIR } from '../domain/constants.ts';

// All layout knowledge for a target project's `.router/` tree lives here.
//
// Since 0.15.0 the tree holds only what the main session's own work produces: plan documents,
// external-writer runs, feature explanations and the symbol cache. Task contracts, run results,
// metrics and the statusline's activity records went with the executor model.

export interface RouterPaths {
  readonly root: string; // absolute path to the .router dir
  readonly repoRoot: string; // the git repo root (parent of .router)
  readonly writesDir: string;
  readonly symbolsDir: string; // code-intelligence symbol caches (gitignored, per-repo)
  readonly symbolLatest: string; // pointer file: hash of the most recently built index
  /** Per-plan directory. Plan artifacts are namespaced so two plans reviewed at once in one
   * repo cannot clobber each other -- and, more sharply, so a reviewer told to read the plan
   * from disk cannot silently be handed a different one. */
  planDir(planId: string): string;
  /**
   * A legacy work plan: `WORKPLAN.md`, or `PLAN.md` when that is the one on disk.
   *
   * READ-ONLY, and nothing writes one any more. The work-plan stage was removed in 0.14.0 --
   * `DESIGN.md` is the only document a plan has now. This accessor survives because plan
   * directories written before that still exist on disk, and they are the only record that
   * finished work finished: `router plans` reads their declared stage, which would otherwise
   * fall back to their `design_approved` DESIGN.md and report completed plans as not started.
   */
  planMd(planId: string): string;
  specCritique(planId: string, round: number): string;
  specDecisions(planId: string): string;
  specLock(planId: string): string;
  symbolCache(hash: string): string;
  /** One external-writer run: `writes/<id>/`. */
  writeDir(id: string): string;
  writeRecord(id: string): string;
  writeBrief(id: string): string;
  writeLog(id: string): string;
  writeHeartbeat(id: string): string;
}

/** Path to a branch's loose ref file. Reading its mtime is a cheap liveness probe. */
export function branchRefPath(repoRoot: string, branch: string): string {
  return join(repoRoot, '.git', 'refs', 'heads', ...branch.split('/'));
}

export function routerPaths(routerDir: string): RouterPaths {
  const root = resolve(routerDir);
  const writeDir = (id: string) => join(root, 'writes', id);
  return {
    root,
    repoRoot: dirname(root),
    writesDir: join(root, 'writes'),
    symbolsDir: join(root, 'symbols'),
    symbolLatest: join(root, 'symbols', 'latest'),
    planDir: (planId) => join(root, 'plans', planId),
    planMd: (planId) => {
      const workplan = join(root, 'plans', planId, 'WORKPLAN.md');
      return existsSync(workplan) ? workplan : join(root, 'plans', planId, 'PLAN.md');
    },
    specCritique: (planId, round) => join(root, 'plans', planId, `critique-${round}.md`),
    specDecisions: (planId) => join(root, 'plans', planId, 'DECISIONS.md'),
    specLock: (planId) => join(root, 'plans', planId, 'spec.lock'),
    symbolCache: (hash: string) => join(root, 'symbols', `${hash}.json`),
    writeDir,
    writeRecord: (id) => join(writeDir(id), 'record.json'),
    writeBrief: (id) => join(writeDir(id), 'BRIEF.md'),
    writeLog: (id) => join(writeDir(id), 'codex.log'),
    writeHeartbeat: (id) => join(writeDir(id), 'heartbeat'),
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
