// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dump } from 'js-yaml';
import type { HandbackItem, ProposedTask, RepoDigest, TaskYaml, WorkerPolicy } from '../domain/types.ts';
import { buildPlannerPrompt } from '../core/planPrompt.ts';
import { parseAndCheckBatch } from '../core/planCheck.ts';
import { classifyRisk, type RiskVerdict } from '../core/risk.ts';
import { listTrackedFiles } from '../io/git.ts';
import { invokeClaudePlanner } from '../io/claudePlan.ts';
import * as store from '../io/store.ts';
import { loadPolicyFromDisk } from './policyLoad.ts';
import { createTask, type TransitionDeps } from './transition.ts';

// The orchestration layer: claude proposes a task batch, router validates it
// deterministically (core), and on success materializes the CLEAR tasks at DRAFT --
// writing the tier-mapped executor into each frozen contract -- while UNCLEAR tasks
// are handed back to the main session. claude never gates anything.
export interface PlannedTaskInfo {
  id: string;
  title: string;
  risk: RiskVerdict;
  depends_on: string[];
}
export type PlanOutcome =
  | { ok: true; created: PlannedTaskInfo[]; handback: HandbackItem[]; truncated: boolean }
  | { ok: false; errors: string[] };

const README_HEAD_LINES = 40;

function readReadmeHead(repoRoot: string): string | undefined {
  const p = `${repoRoot}/README.md`;
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8').split('\n').slice(0, README_HEAD_LINES).join('\n');
}

function renderTaskYaml(t: ProposedTask, tierWorker: WorkerPolicy | undefined): string {
  const task: TaskYaml = {
    schema_version: 1,
    id: t.id,
    title: t.title,
    base_sha: null,
    max_wall_minutes: 30,
    allowed_globs: t.allowed_globs,
    forbidden_globs: t.forbidden_globs,
    max_changed_lines: t.max_changed_lines,
    build_ref: t.build_ref,
    test_ref: t.test_ref,
    verification_params: {},
    ...(t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
    ...(tierWorker !== undefined ? { worker: tierWorker } : {}),
  };
  return dump(task, { lineWidth: 120 });
}

export function runPlan(deps: TransitionDeps, goal: string, opts: { id?: string } = {}): PlanOutcome {
  const { paths } = deps;
  const policy = loadPolicyFromDisk(paths);
  const policyRefs = Object.keys(policy.verification);
  const tracked = listTrackedFiles(paths.repoRoot);
  const readmeHead = readReadmeHead(paths.repoRoot);
  const digest: RepoDigest = {
    files: tracked.files,
    truncated: tracked.truncated,
    verificationRefs: policyRefs,
    ...(readmeHead !== undefined ? { readmeHead } : {}),
  };

  const res = invokeClaudePlanner(buildPlannerPrompt(digest, goal), process.env);
  if (!res.ok) return { ok: false, errors: [`claude planner failed: ${res.error ?? 'unknown error'}`] };

  const checked = parseAndCheckBatch(res.text, { policyRefs, trackedFiles: tracked.files });
  if (!checked.ok) return { ok: false, errors: checked.errors };

  // --id only makes sense for a single-task plan.
  if (opts.id !== undefined && checked.tasks.length !== 1) {
    return { ok: false, errors: [`--id is only valid for a single-task plan (planner returned ${checked.tasks.length})`] };
  }
  const tasks = opts.id !== undefined ? [{ ...checked.tasks[0]!, id: opts.id }] : checked.tasks;

  // All-or-nothing: refuse the batch if any id already exists (no partial batches).
  const clash = tasks.filter((t) => store.readState(paths, t.id) !== null).map((t) => t.id);
  if (clash.length > 0) return { ok: false, errors: clash.map((id) => `task '${id}' already exists`) };

  const tierWorker = policy.tiers?.clear;
  const created: PlannedTaskInfo[] = [];
  for (const t of tasks) {
    createTask(deps, t.id, t.title); // registers DRAFT
    writeFileSync(paths.taskYaml(t.id), renderTaskYaml(t, tierWorker));
    writeFileSync(paths.contractMd(t.id), t.contract_md);
    created.push({ id: t.id, title: t.title, risk: classifyRisk(t.allowed_globs), depends_on: t.depends_on });
  }
  return { ok: true, created, handback: checked.handback, truncated: tracked.truncated };
}
