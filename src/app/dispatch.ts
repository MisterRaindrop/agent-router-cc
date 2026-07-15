// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../io/clock.ts';
import type { ExecutorQuota, ExitClass, MetricRecord, Policy, RunResult, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import { pickExecutor } from '../core/pickExecutor.ts';
import { reclassifyQuota } from '../core/exitTaxonomy.ts';
import { hashContract } from '../core/contractHash.ts';
import { commitAll, rawDiff, resetHard, resolveCommit, worktreeAdd, worktreeRemove, deleteBranch } from '../io/git.ts';
import { buildWorkerEnv } from '../io/env.ts';
import { runBranch, runId as fmtRunId, type RouterPaths } from '../io/paths.ts';
import { readCodexQuota, readClaudeQuota } from '../io/quota.ts';
import * as store from '../io/store.ts';
import { superviseWorker } from '../io/supervisor.ts';
import { makeLauncher } from './codexLauncher.ts';
import { loadPolicyFromGit } from './policyLoad.ts';
import { loadTask } from './taskLoad.ts';
import { estimateCostUsd, parseCodexLog, resolvePrice, type ParsedLog } from './usage.ts';
import { verify } from './verifier.ts';

// The synchronous dispatch driver. Runs ONE clear task to a verified diff in the
// foreground -- no state machine, no lock, no detached supervisor spine. Picks the
// executor by real remaining quota (codex/claude), runs it in an isolated worktree,
// commits, and runs the mechanical verifier. The verified diff stays on the task
// branch for the human to merge. A reactive quota hit switches to the other executor.

export interface DispatchDeps {
  paths: RouterPaths;
  clock: Clock;
}

const RUN = fmtRunId(1); // sync model: one attempt per task

function quotaFor(paths: RouterPaths, kind: WorkerKind): ExecutorQuota | null {
  if (kind === 'codex') {
    const dir = process.env.ROUTER_CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions');
    return readCodexQuota(dir);
  }
  return readClaudeQuota(join(paths.root, 'usage.json'));
}

/** Order the configured executors: the one with the most real quota headroom first. */
export function orderByQuota(paths: RouterPaths, workers: readonly WorkerPolicy[]): { order: WorkerPolicy[]; quotas: ExecutorQuota[] } {
  const quotas = workers.map((w) => quotaFor(paths, w.kind)).filter((q): q is ExecutorQuota => q !== null);
  const picked = quotas.length > 0 ? pickExecutor(quotas) : null;
  if (picked === null) return { order: [...workers], quotas };
  const order = [...workers].sort((a, b) => (a.kind === picked ? -1 : b.kind === picked ? 1 : 0));
  return { order, quotas };
}

/** Run one task synchronously to a verified (or failed) result on its run branch. */
export async function dispatchTask(deps: DispatchDeps, id: string): Promise<RunResult> {
  const { paths, clock } = deps;
  const baseSha = resolveCommit(paths.repoRoot, 'HEAD');
  const { task, contractMdText } = loadTask(paths, id);
  const taskYamlText = readFileSync(paths.taskYaml(id), 'utf8');
  const contractHash = hashContract(taskYamlText, contractMdText);
  const policy = loadPolicyFromGit(paths, baseSha);
  const workers = policy.workers ?? (policy.worker ? [policy.worker] : []);
  if (workers.length === 0) throw new Error(`task ${id}: policy defines no worker/workers`);

  const worktreeDir = paths.worktree(id, RUN);
  const branch = runBranch(id, RUN);
  worktreeRemove(paths.repoRoot, worktreeDir); // idempotent: clear any prior run branch
  deleteBranch(paths.repoRoot, branch);
  worktreeAdd(paths.repoRoot, worktreeDir, branch, baseSha);

  const apiKeyEnvs = [...new Set(workers.map((w) => w.api_key_env).filter((v): v is string => Boolean(v)))];
  const env = buildWorkerEnv(process.env, apiKeyEnvs);
  const logPath = paths.workerLog(id, RUN);

  // Executor chain, quota-ordered: try the executor with the most headroom first; on
  // a real quota hit, reset the worktree and fall through to the next.
  const { order } = orderByQuota(paths, workers);
  let used = order[0]!;
  let exitClass: ExitClass = 'task_failed';
  let outcome = { rc: null as number | null, timedOut: false, stalled: false, startedAtMs: 0, endedAtMs: 0 };
  let switches = 0;

  for (let i = 0; i < order.length; i++) {
    used = order[i]!;
    if (i > 0) writeFileSync(logPath, '');
    const launcher = makeLauncher(used);
    const o = await superviseWorker({
      argv: launcher.buildArgv({ task, worktreeDir, contractMdText, planExists: false }),
      cwd: worktreeDir,
      env,
      logPath,
      heartbeatPath: paths.heartbeat(id, RUN),
      watchDir: worktreeDir,
      maxWallMs: task.max_wall_minutes * 60_000,
      stallMs: (used.stall_minutes ?? 10) * 60_000,
    });
    outcome = o;
    exitClass = reclassifyQuota(o.exitClass, safeRead(logPath), policy.quota_error_pattern);
    if (exitClass === 'quota_exhausted' && i < order.length - 1) {
      switches += 1;
      resetHard(worktreeDir, baseSha);
      continue;
    }
    break;
  }

  if (exitClass === 'ok') commitAll(worktreeDir, `router: ${id} ${RUN}`);

  const launcher = makeLauncher(used);
  const parsed: ParsedLog = (launcher.parseLog ?? parseCodexLog)(safeRead(logPath));
  const model = parsed.model ?? used.model;
  const costUsd = parsed.costUsd ?? (parsed.usage !== null ? estimateCostUsd(parsed.usage, resolvePrice(policy, model, process.env)) : null);

  const result: RunResult = {
    run_id: RUN,
    task_id: id,
    attempt_number: 1,
    exit_class: exitClass,
    rc: outcome.rc,
    timed_out: outcome.timedOut,
    stalled: outcome.stalled,
    env_error: exitClass === 'env_error',
    started_at: new Date(outcome.startedAtMs).toISOString(),
    ended_at: new Date(outcome.endedAtMs).toISOString(),
    wall_seconds: Math.round((outcome.endedAtMs - outcome.startedAtMs) / 1000),
    worker: model !== undefined ? { kind: used.kind, model } : { kind: used.kind },
    ...(switches > 0 ? { executor_switches: switches } : {}),
    ...(parsed.usage !== null ? { tokens: { input: parsed.usage.input, output: parsed.usage.output } } : {}),
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
  };

  if (exitClass === 'ok') {
    const patch = rawDiff(worktreeDir, baseSha, 'HEAD');
    writeFileSync(paths.diffPatch(id, RUN), patch);
    result.diff_sha = createHash('sha256').update(patch).digest('hex');
    result.verifier = verify({
      repoRoot: paths.repoRoot,
      worktreeDir,
      baseSha,
      head: 'HEAD',
      policy,
      task,
      frozenContractHash: contractHash,
      taskYamlText,
      contractMdText,
      env,
    });
  }

  store.writeResult(paths, id, RUN, result);
  appendMetric(deps, result);
  return result;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function appendMetric(deps: DispatchDeps, result: RunResult): void {
  const metric: MetricRecord = {
    ts: deps.clock.nowIso(),
    task_id: result.task_id,
    run_id: result.run_id,
    attempt_number: 1,
    model: result.worker.model ?? null,
    executor: result.worker.kind,
    exit_class: result.exit_class,
    verifier_result: result.verifier?.result ?? null,
    first_pass: result.verifier?.result === 'PASSED',
    tokens_input: result.tokens?.input ?? null,
    tokens_output: result.tokens?.output ?? null,
    cost_usd: result.cost_usd ?? null,
    wall_seconds: result.wall_seconds,
    escalated: false,
    env_error: result.env_error,
  };
  store.appendMetric(deps.paths, metric);
}
