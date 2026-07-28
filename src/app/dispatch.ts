// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../io/clock.ts';
import type { ExecutorQuota, ExitClass, MetricRecord, RunResult, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import { pickExecutor } from '../core/pickExecutor.ts';
import { detectModelMismatch, reclassifyEnvironmentFailure, reclassifyQuota } from '../core/exitTaxonomy.ts';
import { commitAll, rawDiff, resetHard, resolveCommit, worktreeAdd, worktreeRemove, deleteBranch } from '../io/git.ts';
import { buildExecutorEnv, buildWorkerEnv } from '../io/env.ts';
import { runBranch, runId as fmtRunId, type RouterPaths } from '../io/paths.ts';
import { readCodexQuota, readClaudeQuota } from '../io/quota.ts';
import * as store from '../io/store.ts';
import { superviseWorker } from '../io/supervisor.ts';
import { makeLauncher } from './codexLauncher.ts';
import { loadModelConfig, tierWorkers } from './modelConfig.ts';
import { loadTask } from './taskLoad.ts';
import { parseCodexLog, type ParsedLog } from './usage.ts';
import { verifyTask } from './verifier.ts';

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

/** The run's executor record: kind + the model/effort it actually ran under (both optional). */
function workerRecord(used: WorkerPolicy, model: string | undefined): RunResult['worker'] {
  return {
    kind: used.kind,
    ...(model !== undefined ? { model } : {}),
    ...(used.effort !== undefined ? { effort: used.effort } : {}),
  };
}

/** Run one task synchronously to a verified (or failed) result on its run branch. */
export async function dispatchTask(deps: DispatchDeps, id: string): Promise<RunResult> {
  const { paths, clock } = deps;
  const baseSha = resolveCommit(paths.repoRoot, 'HEAD');
  const { task, contractMdText } = loadTask(paths, id);
  // An explicit `worker` pin wins; otherwise resolve the difficulty tier (default
  // weak) against the model config into per-executor candidates (each carrying its
  // tier's model + effort). Router then still picks the executor by real quota.
  const workers: WorkerPolicy[] = task.worker
    ? [task.worker]
    : tierWorkers(loadModelConfig(paths), task.tier ?? 'weak');

  const worktreeDir = paths.worktree(id, RUN);
  const branch = runBranch(id, RUN);
  worktreeRemove(paths.repoRoot, worktreeDir); // idempotent: clear any prior run branch
  deleteBranch(paths.repoRoot, branch);
  worktreeAdd(paths.repoRoot, worktreeDir, branch, baseSha);

  // Verification runs repository-controlled commands: never expose provider keys,
  // proxy credentials, or login-session context to them.
  const verifyEnv = buildWorkerEnv(process.env);
  const logPath = paths.workerLog(id, RUN);

  // Executor chain, quota-ordered: try the executor with the most headroom first;
  // quota/auth/setup failures reset the worktree and fall through to the next.
  const { order } = orderByQuota(paths, workers);
  let used = order[0]!;
  let exitClass: ExitClass = 'task_failed';
  let outcome = { rc: null as number | null, timedOut: false, stalled: false, startedAtMs: 0, endedAtMs: 0 };
  let switches = 0;

  for (let i = 0; i < order.length; i++) {
    used = order[i]!;
    if (i > 0) writeFileSync(logPath, '');
    const launcher = makeLauncher(used);
    const executorEnv = buildExecutorEnv(process.env, used.api_key_env ? [used.api_key_env] : []);
    const o = await superviseWorker({
      argv: launcher.buildArgv({ task, worktreeDir, contractMdText, planExists: false }),
      cwd: worktreeDir,
      env: executorEnv,
      logPath,
      heartbeatPath: paths.heartbeat(id, RUN),
      watchDir: worktreeDir,
      maxWallMs: task.max_wall_minutes * 60_000,
      stallMs: (used.stall_minutes ?? 10) * 60_000,
    });
    outcome = o;
    const log = safeRead(logPath);
    exitClass = reclassifyEnvironmentFailure(reclassifyQuota(o.exitClass, log), log);
    if ((exitClass === 'quota_exhausted' || exitClass === 'env_error') && i < order.length - 1) {
      switches += 1;
      resetHard(worktreeDir, baseSha);
      continue;
    }
    break;
  }

  if (exitClass === 'ok') commitAll(worktreeDir, `router: ${id} ${RUN}`);

  const launcher = makeLauncher(used);
  const finalLog = safeRead(logPath);
  const parsed: ParsedLog = (launcher.parseLog ?? parseCodexLog)(finalLog);
  const model = parsed.model ?? used.model;
  const costUsd = parsed.costUsd ?? null; // provider-reported only (no policy pricing table)
  // A configured slug the executor rejected -> the tier config is likely stale.
  const modelMismatch = exitClass !== 'ok' && detectModelMismatch(finalLog);

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
    worker: workerRecord(used, model),
    base_sha: baseSha,
    ...(switches > 0 ? { executor_switches: switches } : {}),
    ...(modelMismatch ? { model_mismatch: true } : {}),
    ...(parsed.usage !== null ? { tokens: { input: parsed.usage.input, output: parsed.usage.output } } : {}),
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
    ...(parsed.sessionId ? { session_id: parsed.sessionId } : {}),
  };

  if (exitClass === 'ok') {
    const patch = rawDiff(worktreeDir, baseSha, 'HEAD');
    writeFileSync(paths.diffPatch(id, RUN), patch);
    result.diff_sha = createHash('sha256').update(patch).digest('hex');
    result.verifier = verifyTask({
      repoRoot: paths.repoRoot,
      worktreeDir,
      baseSha,
      head: 'HEAD',
      allowedGlobs: task.allowed_globs,
      ...(task.forbidden_globs !== undefined ? { forbiddenGlobs: task.forbidden_globs } : {}),
      ...(task.max_changed_lines !== undefined ? { maxChangedLines: task.max_changed_lines } : {}),
      verify: task.verify ?? [],
      env: verifyEnv,
    });
  }

  store.writeResult(paths, id, RUN, result);
  appendMetric(deps, result);
  return result;
}

/**
 * Resume a prior dispatch's executor session with follow-up feedback, instead of a
 * cold restart -- the executor keeps its context, so the retry is cheaper. Reuses the
 * SAME worktree. Fail-loud continuity guard: if the resumed run reports a different
 * session id than the prior run, we do NOT commit/verify -- a fresh session is not a
 * resume, and silently treating it as one would defeat the point.
 */
export async function resumeTask(deps: DispatchDeps, id: string, feedback: string): Promise<RunResult> {
  const { paths } = deps;
  const prev = store.readResult(paths, id, RUN);
  if (prev === null) throw new Error(`no prior dispatch for ${id}; run \`router dispatch ${id}\` first`);
  const priorSession = prev.session_id ?? null;
  if (!priorSession) throw new Error(`prior run for ${id} has no session id; resume unavailable -- re-dispatch instead`);
  const worktreeDir = paths.worktree(id, RUN);
  if (!existsSync(worktreeDir)) throw new Error(`worktree for ${id} is gone; resume unavailable -- re-dispatch instead`);
  const baseSha = prev.base_sha ?? resolveCommit(worktreeDir, 'HEAD');

  const { task } = loadTask(paths, id);
  // Resume replays the prior run's exact executor pin (model + effort) so it
  // re-attaches with the same model it dispatched under.
  const used: WorkerPolicy = {
    kind: prev.worker.kind,
    ...(prev.worker.model ? { model: prev.worker.model } : {}),
    ...(prev.worker.effort ? { effort: prev.worker.effort } : {}),
  };
  const launcher = makeLauncher(used);
  const logPath = paths.workerLog(id, RUN);
  writeFileSync(logPath, '');
  const verifyEnv = buildWorkerEnv(process.env);
  const executorEnv = buildExecutorEnv(process.env, used.api_key_env ? [used.api_key_env] : []);

  const o = await superviseWorker({
    argv: launcher.buildResumeArgv(worktreeDir, priorSession, feedback),
    cwd: worktreeDir,
    env: executorEnv,
    logPath,
    heartbeatPath: paths.heartbeat(id, RUN),
    watchDir: worktreeDir,
    maxWallMs: task.max_wall_minutes * 60_000,
    stallMs: (used.stall_minutes ?? 10) * 60_000,
  });
  const log = safeRead(logPath);
  const exitClass: ExitClass = reclassifyEnvironmentFailure(reclassifyQuota(o.exitClass, log), log);
  const parsed: ParsedLog = (launcher.parseLog ?? parseCodexLog)(log);
  const newSession = parsed.sessionId ?? null;
  const mismatch = newSession !== null && newSession !== priorSession;

  const model = parsed.model ?? used.model;
  const costUsd = parsed.costUsd ?? null;
  const modelMismatch = exitClass !== 'ok' && detectModelMismatch(log);
  const result: RunResult = {
    run_id: RUN,
    task_id: id,
    attempt_number: prev.attempt_number + 1,
    exit_class: mismatch ? 'task_failed' : exitClass,
    rc: o.rc,
    timed_out: o.timedOut,
    stalled: o.stalled,
    env_error: exitClass === 'env_error',
    started_at: new Date(o.startedAtMs).toISOString(),
    ended_at: new Date(o.endedAtMs).toISOString(),
    wall_seconds: Math.round((o.endedAtMs - o.startedAtMs) / 1000),
    worker: workerRecord(used, model),
    base_sha: baseSha,
    resumed: true,
    session_id: newSession ?? priorSession,
    ...(mismatch ? { resume_session_mismatch: true } : {}),
    ...(modelMismatch ? { model_mismatch: true } : {}),
    ...(parsed.usage !== null ? { tokens: { input: parsed.usage.input, output: parsed.usage.output } } : {}),
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
  };

  if (!mismatch && exitClass === 'ok') {
    commitAll(worktreeDir, `router: ${id} ${RUN} (resume)`);
    const patch = rawDiff(worktreeDir, baseSha, 'HEAD');
    writeFileSync(paths.diffPatch(id, RUN), patch);
    result.diff_sha = createHash('sha256').update(patch).digest('hex');
    result.verifier = verifyTask({
      repoRoot: paths.repoRoot,
      worktreeDir,
      baseSha,
      head: 'HEAD',
      allowedGlobs: task.allowed_globs,
      ...(task.forbidden_globs !== undefined ? { forbiddenGlobs: task.forbidden_globs } : {}),
      ...(task.max_changed_lines !== undefined ? { maxChangedLines: task.max_changed_lines } : {}),
      verify: task.verify ?? [],
      env: verifyEnv,
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
