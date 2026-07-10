// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dump } from 'js-yaml';
import type { ProposedContract, RepoDigest, TaskYaml } from '../domain/types.ts';
import { buildPlannerPrompt } from '../core/planPrompt.ts';
import { parseAndCheck } from '../core/planCheck.ts';
import { classifyRisk, type RiskVerdict } from '../core/risk.ts';
import { listTrackedFiles } from '../io/git.ts';
import { invokeClaudePlanner } from '../io/claudePlan.ts';
import { loadPolicyFromDisk } from './policyLoad.ts';
import { createTask, type TransitionDeps } from './transition.ts';

// The orchestration layer: claude proposes a contract, router validates it
// deterministically (core), and on success materializes a DRAFT task. claude never
// gates anything -- its output is an untrusted artifact.
export type PlanOutcome =
  | { ok: true; id: string; contract: ProposedContract; risk: RiskVerdict; truncated: boolean }
  | { ok: false; errors: string[] };

const README_HEAD_LINES = 40;

function readReadmeHead(repoRoot: string): string | undefined {
  const p = `${repoRoot}/README.md`;
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8').split('\n').slice(0, README_HEAD_LINES).join('\n');
}

function renderTaskYaml(c: ProposedContract): string {
  const task: TaskYaml = {
    schema_version: 1,
    id: c.id,
    title: c.title,
    base_sha: null,
    max_wall_minutes: 30,
    allowed_globs: c.allowed_globs,
    forbidden_globs: c.forbidden_globs,
    max_changed_lines: c.max_changed_lines,
    build_ref: c.build_ref,
    test_ref: c.test_ref,
    verification_params: {},
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

  const checked = parseAndCheck(res.text, { policyRefs, trackedFiles: tracked.files });
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const contract = checked.contract;
  const id = opts.id ?? contract.id;
  createTask(deps, id, contract.title); // registers DRAFT
  writeFileSync(paths.taskYaml(id), renderTaskYaml(contract));
  writeFileSync(paths.contractMd(id), contract.contract_md);

  return { ok: true, id, contract, risk: classifyRisk(contract.allowed_globs), truncated: tracked.truncated };
}
