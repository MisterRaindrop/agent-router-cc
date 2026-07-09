import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MetricRecord, RunResult, StateFile, TaskYaml, WorkerKind } from '../domain/types.ts';
import { countsAsAttempt } from '../core/exitTaxonomy.ts';
import { commitAll, rawDiff, resolveCommit, worktreeAdd } from '../io/git.ts';
import { buildWorkerEnv } from '../io/env.ts';
import { runBranch } from '../io/paths.ts';
import * as store from '../io/store.ts';
import { superviseWorker } from '../io/supervisor.ts';
import { loadPolicyFromDisk, loadPolicyFromGit } from './policyLoad.ts';
import { loadTask } from './taskLoad.ts';
import { verify } from './verifier.ts';
import { currentState, transition, type TransitionDeps } from './transition.ts';

// End-to-end run execution. startRun (the `router run` half) creates the worktree,
// takes the concurrency slot, writes the lease, and moves QUEUED→RUNNING.
// runWorkerBody (the detached `_worker-run` half) supervises the worker, commits
// its checkpoint, runs the mechanical verifier, and finalizes to PASSED/FAILED.

export class ConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(`max_concurrent_workers (${limit}) reached`);
    this.name = 'ConcurrencyLimitError';
  }
}
export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

// A launcher turns a run context into the worker argv. Real codex in step 15;
// tests inject a fake that edits files directly.
export interface WorkerContext {
  task: TaskYaml;
  worktreeDir: string;
  contractMdText: string;
  planExists: boolean;
}
export interface WorkerLauncher {
  kind: WorkerKind;
  model?: string;
  buildArgv(ctx: WorkerContext): string[];
}

function repoRootOf(deps: TransitionDeps): string {
  return dirname(deps.paths.root);
}

function nextRunNumber(deps: TransitionDeps, id: string): number {
  const nums = store.listRunIds(deps.paths, id).map((r) => Number(r.slice('run-'.length)));
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
}

export interface StartedRun {
  runId: string;
  worktreeDir: string;
  attemptNumber: number;
}

/** `router run`: allocate a run, create the worktree, move QUEUED→RUNNING. */
export function startRun(deps: TransitionDeps, id: string): StartedRun {
  const { paths } = deps;
  const st = currentState(paths, id);
  if (st === null) throw new RunStateError(`no such task: ${id}`);
  if (st.state !== 'QUEUED') throw new RunStateError(`task ${id} is ${st.state}, expected QUEUED`);
  if (st.base_sha === null) throw new RunStateError(`task ${id} has no frozen base_sha`);

  const limit = safeMaxConcurrency(deps);
  const runningElsewhere = store
    .listTaskIds(paths)
    .filter((t) => t !== id)
    .filter((t) => currentState(paths, t)?.state === 'RUNNING').length;
  if (runningElsewhere >= limit) throw new ConcurrencyLimitError(limit);

  const attemptNumber = st.attempt_number + 1;
  const run = `run-${String(nextRunNumber(deps, id)).padStart(3, '0')}`;
  const worktreeDir = paths.worktree(id, run);
  const branch = runBranch(id, run);
  const maxWallMinutes = loadTask(paths, id).task.max_wall_minutes;

  // Pin to the frozen base_sha; a colliding branch means unclean recovery — fail fast.
  worktreeAdd(repoRootOf(deps), worktreeDir, branch, st.base_sha);

  const startedAt = deps.clock.nowIso();
  store.writeLease(paths, id, run, {
    run_id: run,
    task_id: id,
    attempt_number: attemptNumber,
    supervisor_pid: process.pid,
    worker_pgid: 0, // filled by runWorkerBody once the worker is spawned
    host: hostName(),
    started_at: startedAt,
    max_wall_minutes: maxWallMinutes,
    wall_deadline: new Date(Date.parse(startedAt) + maxWallMinutes * 60_000).toISOString(),
    heartbeat_path: 'heartbeat',
  });

  transition(deps, id, 'RUNNING', { actor: 'cli:run', runId: run, meta: { attempt_number: attemptNumber } });
  return { runId: run, worktreeDir, attemptNumber };
}

function hostName(): string {
  return process.env.HOSTNAME ?? 'localhost';
}
function safeMaxConcurrency(deps: TransitionDeps): number {
  try {
    return loadPolicyFromDisk(deps.paths).max_concurrent_workers ?? 1;
  } catch {
    return 1;
  }
}

/** The detached `_worker-run` body: supervise → checkpoint commit → verify → finalize. */
export async function runWorkerBody(
  deps: TransitionDeps,
  id: string,
  runId: string,
  launcher: WorkerLauncher,
): Promise<RunResult> {
  const { paths, clock } = deps;
  const st = currentState(paths, id);
  if (st === null || st.state !== 'RUNNING' || st.current_run !== runId) {
    throw new RunStateError(`task ${id} is not RUNNING run ${runId}`);
  }
  const baseSha = st.base_sha!;
  const contractHash = st.contract_hash!;
  const { task, taskYamlText, contractMdText } = loadTask(paths, id);
  const policyGit = loadPolicyFromGit(paths, baseSha);
  const worktreeDir = paths.worktree(id, runId);
  const apiKeyEnv = policyGit.worker?.api_key_env;
  const env = buildWorkerEnv(process.env, apiKeyEnv !== undefined ? [apiKeyEnv] : []);

  const argv = launcher.buildArgv({
    task,
    worktreeDir,
    contractMdText,
    planExists: false,
  });

  const outcome = await superviseWorker({
    argv,
    cwd: worktreeDir,
    env,
    logPath: paths.workerLog(id, runId),
    heartbeatPath: paths.heartbeat(id, runId),
    watchDir: worktreeDir,
    maxWallMs: task.max_wall_minutes * 60_000,
    stallMs: (policyGit.worker?.stall_minutes ?? 10) * 60_000,
    onPgid: (pgid) => {
      const lease = store.readLease(paths, id, runId);
      if (lease !== null) store.writeLease(paths, id, runId, { ...lease, worker_pgid: pgid });
    },
  });

  // Router owns the checkpoint commit: capture whatever the worker left.
  if (outcome.exitClass === 'ok') commitAll(worktreeDir, `router: ${id} ${runId}`);

  const result: RunResult = {
    run_id: runId,
    task_id: id,
    attempt_number: st.attempt_number,
    exit_class: outcome.exitClass,
    rc: outcome.rc,
    timed_out: outcome.timedOut,
    stalled: outcome.stalled,
    env_error: outcome.exitClass === 'env_error',
    started_at: new Date(outcome.startedAtMs).toISOString(),
    ended_at: new Date(outcome.endedAtMs).toISOString(),
    wall_seconds: Math.round((outcome.endedAtMs - outcome.startedAtMs) / 1000),
    worker: launcher.model !== undefined ? { kind: launcher.kind, model: launcher.model } : { kind: launcher.kind },
  };

  let finalState: 'PASSED' | 'FAILED';
  if (outcome.exitClass === 'ok') {
    transition(deps, id, 'VERIFYING', { actor: 'router:worker', runId });
    const patch = rawDiff(worktreeDir, baseSha, 'HEAD');
    writeFileSync(paths.diffPatch(id, runId), patch);
    result.diff_sha = createHash('sha256').update(patch).digest('hex');
    const report = verify({
      repoRoot: repoRootOf(deps),
      worktreeDir,
      baseSha,
      head: 'HEAD',
      policy: policyGit,
      task,
      frozenContractHash: contractHash,
      taskYamlText: readFileSync(paths.taskYaml(id), 'utf8'),
      contractMdText: safeRead(paths.contractMd(id)),
      env,
    });
    result.verifier = report;
    finalState = report.result;
  } else {
    // Worker did not finish cleanly — no verification, straight to FAILED.
    finalState = 'FAILED';
  }

  store.writeResult(paths, id, runId, result);
  appendRunMetric(deps, result, st);
  transition(deps, id, finalState, {
    actor: 'router:worker',
    runId,
    meta: { exit_class: outcome.exitClass, counts_as_attempt: countsAsAttempt(outcome.exitClass) },
  });
  return result;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function appendRunMetric(deps: TransitionDeps, result: RunResult, st: StateFile): void {
  const metric: MetricRecord = {
    ts: deps.clock.nowIso(),
    task_id: result.task_id,
    run_id: result.run_id,
    attempt_number: result.attempt_number,
    exit_class: result.exit_class,
    verifier_result: result.verifier?.result ?? null,
    first_pass: result.attempt_number === 1 && result.verifier?.result === 'PASSED',
    tokens_input: result.tokens?.input ?? null,
    tokens_output: result.tokens?.output ?? null,
    cost_usd: result.cost_usd ?? null,
    wall_seconds: result.wall_seconds,
    escalated: false,
    env_error: result.env_error,
  };
  void st;
  store.appendMetric(deps.paths, metric);
}
