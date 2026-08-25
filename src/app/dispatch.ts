// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../io/clock.ts';
import type { DeliveryHeader, ExecutorQuota, ExitClass, GateConfig, MetricRecord, RunPhaseTimings, RunResult, TaskYaml, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import { pickExecutor } from '../core/pickExecutor.ts';
import {
  detectContractConflict,
  detectModelMismatch,
  reclassifyEnvironmentFailure,
  reclassifyQuota,
} from '../core/exitTaxonomy.ts';
import { effectiveRisk } from '../core/risk.ts';
import {
  assertTaskIdentity,
  branchExists,
  checkoutRef,
  collectDiff,
  createBranchStrict,
  currentBranch,
  rawDiff,
  rescueCommit,
  resetHardTracked,
  updateRef,
  resolveCommit,
  submoduleDirty,
  uncommittedSourceFiles,
  uncommittedSourceFilesOrUnknown,
} from '../io/git.ts';
import { buildExecutorEnv, buildWorkerEnv } from '../io/env.ts';
import { startHeartbeat } from '../io/heartbeat.ts';
import { acquireLock, ownsLock, type LockHandle } from '../io/lock.ts';
import { branchRefPath, runId as fmtRunId, taskBranch, type RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import { loadGateConfig } from './gateConfig.ts';
import { fingerprintState, stateDiff } from './stateGuard.ts';
import { readCodexQuota, readClaudeQuota } from '../io/quota.ts';
import * as store from '../io/store.ts';
import { superviseWorker } from '../io/supervisor.ts';
import { makeLauncher } from './codexLauncher.ts';
import { loadModelConfig, tierWorkers } from './modelConfig.ts';
import { loadTask } from './taskLoad.ts';
import { RunStatusWriter, terminalStateFor } from './runStatus.ts';
import {
  loadTaskContext,
  TASK_CONTEXT_SOFT_LIMIT,
  type TaskContext,
} from './taskContext.ts';
import { parseCodexLog, parseDeliveryHeader, type ParsedLog } from './usage.ts';
import { verifyTask } from './verifier.ts';

// The synchronous dispatch driver. Runs ONE task to a verified diff in the foreground:
// picks the executor by real remaining quota (codex/claude), runs it IN THE USER'S OWN
// CHECKOUT on a dedicated `router/<id>` branch, then runs the mechanical verifier. The
// verified commits stay on that branch for the human to merge. A reactive quota hit
// switches to the other executor.
//
// It used to run in a per-task git worktree. That was dropped because a fresh worktree has
// no dependencies, no build objects and no configure output, so real projects cannot
// compile in one -- this repo only got away with it because the worktree sat under
// `.router/worktrees/`, inside the repo, where Node's upward module resolution found the
// root's node_modules by accident. A C project has no such fallback: a new worktree is a
// full rebuild, and the build has to happen in the main checkout anyway, which then adds a
// "carry the code back" step.
//
// Sharing the user's checkout is what makes the rest of this file careful. Everything from
// the first write to the executor's death happens under one exclusive lock, held by this
// process; the user's uncommitted work is committed before anything moves; and no
// destructive step runs without first asserting we are still on the task's own branch.

export interface DispatchDeps {
  paths: RouterPaths;
  clock: Clock;
}

/**
 * What the exclusive-lock envelope hands to the code running inside it.
 *
 * `stillOwned` exists because the state guard cannot watch `gate.lock`: our own out-of-process
 * heartbeat rewrites it every few seconds, so it has to be excluded from the content diff -- and
 * an exclusion is a write channel unless something else closes it. This is that something else.
 */
export interface RunEnvelope {
  /** Publish the executor's process group into the lock, so a later reclaimer can reap it. */
  onExecPgid: (pgid: number) => void;
  /** Whether the checkout lock still names this run. False means somebody rewrote it. */
  stillOwned: () => boolean;
}

export interface PreparedRun {
  id: string;
  task: TaskYaml;
  contractMdText: string;
  /** The repository root. The executor works here; there is no separate checkout any more. */
  workDir: string;
  branch: string;
  baseSha: string;
  context: TaskContext | null;
  workers: WorkerPolicy[];
  logPath: string;
  status: RunStatusWriter;
  /** Step 4's rescue of the user's uncommitted work, or null when the tree was already clean. */
  rescue: { sha: string; files: string[] } | null;
  /** Submodule content dirt found at preparation time -- reported, never acted on. */
  dirtySubmodules: string[];
}

/**
 * The metrics label for an executor row (MetricRecord.run_id).
 *
 * Not a path any more -- run artifacts live directly in `tasks/<id>/`. It survives only as a
 * label in the append-only metrics file, where a constant reads better than a field that means
 * different things in old and new rows.
 */
const RUN_LABEL = fmtRunId(1);

// How long a silent executor is tolerated before the stall watchdog kills it. The signal is
// coarse -- log growth plus worktree mtime -- and a high-effort model reasoning between tool
// calls emits neither. Measured: a run was killed at ten minutes of silence AFTER its gate had
// already passed, discarding verified work, so the bound has to sit above real thinking time
// and let `max_wall_minutes` be the hard stop.
const STALL_MINUTES_DEFAULT = 20;

/**
 * Kept out of every rescue commit and every cleanliness check.
 *
 * `.router/` ships a `*` gitignore, so normally git never sees it -- but this flow commits on
 * the user's behalf in the user's own repository, and "we swept our own bookkeeping into your
 * history" must not be one missing .gitignore away. The exclusion is explicit rather than
 * inherited.
 */
const ROUTER_STATE_EXCLUDE = ['.router'] as const;

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

/** Prepare one task's isolated worktree and executor candidates. */
/**
 * Steps 4-6: rescue whatever the user had uncommitted, cut the task branch, freeze the base.
 *
 * MUST be called with the gate lock already held -- see dispatchTask. Every line here writes
 * to the user's checkout, which is exactly why the lock cannot wait until dispatch time: two
 * concurrent `go` runs would otherwise commit and switch branches over each other before
 * either had anything to be exclusive about.
 *
 * Order is load-bearing. Rescue first, so the branch is cut from a commit that already
 * contains the user's work and nothing is left dangling in the working tree. Then the
 * branch, strictly -- a name that already exists is refused, never adopted.
 */
export function prepareRun(deps: DispatchDeps, id: string): PreparedRun {
  const { paths } = deps;
  const { task, contractMdText } = loadTask(paths, id);
  const workDir = paths.repoRoot;
  const status = new RunStatusWriter({
    path: paths.runStatus(id),
    workDir,
    budgetMinutes: task.max_wall_minutes,
    clock: deps.clock,
  });
  try {
    status.transition('worktree');
    const branch = taskBranch(id);
    // Refuse before touching anything. Cutting the rescue commit and only then discovering the
    // branch is taken would leave the user with a commit made for a run that never started.
    if (currentBranch(paths.repoRoot) === branch) {
      throw new Error(
        `already on ${branch}; that branch belongs to a previous dispatch of ${id}. ` +
          `Merge or delete it, or use \`router resume ${id}\` to continue that session.`,
      );
    }
    const dirtySubmodules = submoduleDirty(paths.repoRoot, ROUTER_STATE_EXCLUDE);
    const rescue = rescueCommit(
      paths.repoRoot,
      `router: rescue uncommitted work before ${id}`,
      ROUTER_STATE_EXCLUDE,
    );
    // After the rescue, so the base contains the user's work rather than sitting behind it.
    const baseSha = resolveCommit(paths.repoRoot, 'HEAD');
    const context = loadTaskContext(paths, task);
    if (context !== null && context.base_sha !== baseSha) {
      throw new Error(
        `TASK_CONTEXT.md base_sha mismatch for task ${id}: context describes "${context.base_sha}", ` +
          `but dispatch base is "${baseSha}"; regenerate the task context for this revision`,
      );
    }
    // An explicit `worker` pin wins; otherwise resolve the difficulty tier (default
    // weak) against the model config into per-executor candidates (each carrying its
    // tier's model + effort). Router then still picks the executor by real quota.
    const workers: WorkerPolicy[] = task.worker
      ? [task.worker]
      : tierWorkers(loadModelConfig(paths), task.tier ?? 'weak');

    createBranchStrict(paths.repoRoot, branch);

    return {
      id,
      task,
      contractMdText,
      workDir,
      branch,
      baseSha,
      context,
      workers,
      logPath: paths.workerLog(id),
      status,
      rescue,
      dirtySubmodules,
    };
  } catch (error) {
    status.terminal('failed');
    throw error;
  }
}

/** Run one prepared task to a verified (or failed) result on its run branch. */
async function runPreparedObserved(
  deps: DispatchDeps,
  prep: PreparedRun,
  gateConfig?: GateConfig,
  envelope?: RunEnvelope,
): Promise<RunResult> {
  const { paths } = deps;
  const { id, task, contractMdText, workDir, branch, baseSha, context, workers, logPath } = prep;
  const refPath = branchRefPath(workDir, branch);
  if (task.mode === 'probe') rmSync(paths.diffPatch(id), { force: true });
  // Verification runs repository-controlled commands: never expose provider keys,
  // proxy credentials, or login-session context to them.
  const verifyEnv = buildWorkerEnv(process.env);

  // Executor chain, quota-ordered: try the executor with the most headroom first;
  // quota/auth/setup failures reset the worktree and fall through to the next.
  // Must NOT 11 detection: what the orchestration state looked like before any executor ran.
  const stateBefore = fingerprintState(paths, id);
  const { order } = orderByQuota(paths, workers);
  let used = order[0]!;
  let exitClass: ExitClass = 'task_failed';
  let outcome = { rc: null as number | null, timedOut: false, stalled: false, startedAtMs: 0, endedAtMs: 0 };
  let switches = 0;
  let groupSurvived = false;
  const discarded: string[] = [];

  for (let i = 0; i < order.length; i++) {
    used = order[i]!;
    if (i > 0) writeFileSync(logPath, '');
    const launcher = makeLauncher(used);
    const executorEnv = buildExecutorEnv(process.env, used.api_key_env ? [used.api_key_env] : []);
    const stallMs = (used.stall_minutes ?? STALL_MINUTES_DEFAULT) * 60_000;
    const initialLogChars = safeRead(logPath).length;
    prep.status.executorStarting(stallMs);
    const o = await superviseWorker({
      argv: launcher.buildArgv({
        task,
        workDir,
        contractMdText,
        planExists: false,
        taskContext: context,
      }),
      cwd: workDir,
      env: executorEnv,
      logPath,
      heartbeatPath: paths.heartbeat(id),
      watchPaths: [refPath],
      maxWallMs: task.max_wall_minutes * 60_000,
      stallMs,
      onPgid: (pgid) => {
        prep.status.executorWorking(logPath, used.kind, initialLogChars);
        // Publish the group into the LOCK. This was the missing wire: `recordExecPgid` existed
        // and only the io-lock test ever called it, so in production the lock never carried an
        // execPgid -- and a reclaimer therefore could not clean up the orphan it was supposed to
        // (Must NOT 6, fault injection 8c). The 8c test called the primitive by hand and so
        // passed straight over the gap.
        envelope?.onExecPgid(pgid);
      },
    });
    prep.status.finishExecutor();
    outcome = o;
    const log = safeRead(logPath);
    exitClass = reclassifyEnvironmentFailure(reclassifyQuota(o.exitClass, log), log);
    if (o.groupSurvived) {
      // Something in the executor's process group outlived SIGKILL and is still able to write
      // this checkout. Nothing after this point may run: not a reset for the next executor, not
      // the closeout check, and certainly not verification -- every one of them would be racing
      // a writer we have already failed to stop.
      groupSurvived = true;
      exitClass = 'task_failed';
      break;
    }
    const parsedAttempt: ParsedLog = (launcher.parseLog ?? parseCodexLog)(log);
    if (detectContractConflict(parsedAttempt.finalMessage)) {
      exitClass = 'contract_conflict';
      break;
    }
    if ((exitClass === 'quota_exhausted' || exitClass === 'env_error') && i < order.length - 1) {
      switches += 1;
      // Two guards before anything destructive, both of which the worktree model made
      // unnecessary and the shared checkout makes mandatory.
      //
      // The assertion first: if the user checked something else out mid-run, or this branch
      // name belongs to a different task, the reset would discard work that was never part of
      // this run. Refuse rather than report.
      assertTaskIdentity(workDir, { branch, baseSha });
      // Then rescue. `resetHard` is deliberately NOT used here -- it also runs `git clean -fd`,
      // which deletes files created while the executor was running, the user's included. This
      // commit is unreachable after the reset but recoverable by sha, which is why the sha is
      // reported rather than dropped.
      const salvage = rescueCommit(
        workDir,
        `router: salvage ${id} before executor switch`,
        ROUTER_STATE_EXCLUDE,
      );
      if (salvage !== null) {
        // Make it REACHABLE before the reset, not merely remembered. The sha used to go into an
        // in-memory array and reach disk only when the whole run finished writing result.json --
        // so a crash anywhere in between lost the only pointer to a commit that was made
        // precisely so nothing would be lost, and `git gc` would then collect it. A ref survives
        // both the crash and the gc.
        updateRef(workDir, `refs/router/salvage/${id}/${discarded.length + 1}`, salvage.sha);
        discarded.push(salvage.sha);
      }
      resetHardTracked(workDir, baseSha);
      continue;
    }
    break;
  }

  const launcher = makeLauncher(used);
  const finalLog = safeRead(logPath);
  const parsed: ParsedLog = (launcher.parseLog ?? parseCodexLog)(finalLog);
  const conflict = detectContractConflict(parsed.finalMessage);
  if (conflict) exitClass = 'contract_conflict';
  // Step 9, the closing invariant. There used to be a catch-all `commitAll` here that swept up
  // whatever the executor left behind; the contract now requires the executor to commit each
  // functional unit itself, so the sweep is gone -- and dropping it without this check would be
  // a correctness hole. A file the executor forgot to commit never enters `base_sha..HEAD`, so
  // every gate passes without ever seeing it, and the run reports success while unreviewed code
  // sits in the user's checkout.
  // Compare before anything else is decided: state tampering is not a code defect to be weighed
  // against the diff, it is a contract violation, and it is invisible to every gate because
  // `.router/` is gitignored.
  const tampering = stateDiff(stateBefore, fingerprintState(paths, id));
  // The one file the fingerprint cannot watch, checked the only way it can be: by identity
  // rather than by content. Our heartbeat rewrites gate.lock constantly, so it is excluded from
  // the diff -- and this is what stops that exclusion from being a free channel for an executor
  // to write itself a lock and let a second process into the checkout.
  if (envelope !== undefined && !envelope.stillOwned()) {
    tampering.push('modified gate.lock (it no longer carries this run’s owner token)');
  }
  if (tampering.length > 0 && exitClass === 'ok') exitClass = 'task_failed';

  let closeout: RunResult['closeout'];
  // A probe is exempt, and has to be: it is required to produce NO diff, so demanding that it
  // commit its work would be self-contradictory. Its equivalent check is `probe_no_diff`, which
  // counts uncommitted files too -- so "wrote something and did not commit it" still fails,
  // just as the right kind of failure.
  if (exitClass === 'ok' && task.mode !== 'probe') {
    prep.status.transition('gating');
    try {
      assertTaskIdentity(workDir, { branch, baseSha });
      const leftover = uncommittedSourceFiles(workDir, ROUTER_STATE_EXCLUDE);
      if (leftover.length > 0) {
        closeout = {
          ok: false,
          reason: 'uncommitted source files remain; the executor did not commit its last unit',
          files: leftover,
        };
        exitClass = 'task_failed';
      } else {
        closeout = { ok: true };
      }
    } catch (error) {
      closeout = { ok: false, reason: (error as Error).message, files: [] };
      exitClass = 'task_failed';
    }
  }
  const model = parsed.model ?? used.model;
  const costUsd = parsed.costUsd ?? null; // provider-reported only (no policy pricing table)
  // A configured slug the executor rejected -> the tier config is likely stale.
  const modelMismatch = exitClass !== 'ok' && exitClass !== 'contract_conflict' && detectModelMismatch(finalLog);

  const result: RunResult = {
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
    branch,
    ...(prep.rescue !== null ? { rescue_sha: prep.rescue.sha } : {}),
    ...(discarded.length > 0 ? { discarded_shas: discarded } : {}),
    ...(closeout !== undefined ? { closeout } : {}),
    ...(groupSurvived ? { executor_group_survived: true } : {}),
    ...(tampering.length > 0 ? { state_tampering: tampering } : {}),
    ...(prep.dirtySubmodules.length > 0 ? { dirty_submodules: prep.dirtySubmodules } : {}),
    ...(context !== null && context.chars > TASK_CONTEXT_SOFT_LIMIT ? { context_oversize: true } : {}),
    ...(switches > 0 ? { executor_switches: switches } : {}),
    ...(modelMismatch ? { model_mismatch: true } : {}),
    ...(conflict ? { conflict: true } : {}),
    ...(parsed.commandsRun !== undefined ? { commands_run: parsed.commandsRun } : {}),
    ...(parsed.usage !== null ? { tokens: { input: parsed.usage.input, output: parsed.usage.output } } : {}),
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
    ...(parsed.sessionId ? { session_id: parsed.sessionId } : {}),
  };
  const delivery = persistDelivery(paths, id, task, parsed.finalMessage);
  if (delivery !== undefined) result.delivery = delivery;
  if (conflict) rmSync(paths.diffPatch(id), { force: true });
  // A run that did not end `ok` is never committed, so its work would otherwise look lost.
  // Say plainly that it is still on disk: an executor killed after it had already finished is
  // recoverable, and silently discarding that work is the worse failure.
  if (exitClass !== 'ok') {
    // Reporting, not deciding: a failure here must not mask the failure being reported, so
    // "could not determine" (null) is left off the record rather than becoming `false`.
    const leftoverOnFailure = uncommittedSourceFilesOrUnknown(workDir, ROUTER_STATE_EXCLUDE);
    if (leftoverOnFailure !== null && leftoverOnFailure.length > 0) result.uncommitted_changes = true;
  }

  if (exitClass === 'ok') {
    if (task.mode !== 'probe') {
      const patch = rawDiff(workDir, baseSha, 'HEAD');
      writeFileSync(paths.diffPatch(id), patch);
      result.diff_sha = createHash('sha256').update(patch).digest('hex');
    }
    // Exactly which commit the verifier is about to judge. `land` refuses to merge a task branch
    // whose tip has moved past it: a PASSED record used to authorize the BRANCH rather than a
    // commit, so anything appended afterwards -- by a resume, or by hand -- was merged unverified
    // on the strength of a verdict that had never seen it.
    result.verified_head = resolveCommit(workDir, 'HEAD');
    prep.status.transition('verify');
    result.verifier = verifyTask({
      repoRoot: paths.repoRoot,
      workDir,
      baseSha,
      head: 'HEAD',
      ...(task.mode !== undefined ? { mode: task.mode } : {}),
      allowedGlobs: task.allowed_globs,
      ...(task.forbidden_globs !== undefined ? { forbiddenGlobs: task.forbidden_globs } : {}),
      ...(task.max_changed_lines !== undefined ? { maxChangedLines: task.max_changed_lines } : {}),
      verify: task.verify ?? [],
      env: verifyEnv,
      uncommittedExclude: ROUTER_STATE_EXCLUDE,
      // The project's own build/test commands and reset, when it declares them. Without this
      // the flow only ever ran `task.verify`, so `clean_triggers` was documented and dead --
      // and a warm checkout could pass a diff on objects left from an earlier build.
      ...(gateConfig !== undefined ? { gate: gateConfig } : {}),
      ...(gateConfig !== undefined ? { gateEnv: buildWorkerEnv(process.env, gateConfig.env ?? []) } : {}),
    });
    attachEffectiveRisk(result, task, workDir, baseSha);
  }

  const phaseTimings = prep.status.terminal(
    terminalStateFor(result.exit_class, result.verifier?.result === 'PASSED'),
  );
  store.writeResult(paths, id, result);
  appendMetric(deps, result, task, context, phaseTimings);
  return result;
}

/** Run one prepared task, recording a failed terminal state on every handled exception. */
export async function runPrepared(
  deps: DispatchDeps,
  prep: PreparedRun,
  gateConfig?: GateConfig,
  envelope?: RunEnvelope,
): Promise<RunResult> {
  try {
    return await runPreparedObserved(deps, prep, gateConfig, envelope);
  } catch (error) {
    prep.status.terminal('failed');
    throw error;
  }
}

/** Thrown when another process holds the checkout. Carries the holder so the CLI can name it. */
export class CheckoutBusyError extends Error {
  readonly holderPid: number | null;
  readonly holderBeatAtMs: number | null;
  constructor(message: string, holderPid: number | null, holderBeatAtMs: number | null) {
    super(message);
    this.name = 'CheckoutBusyError';
    this.holderPid = holderPid;
    this.holderBeatAtMs = holderBeatAtMs;
  }
}

/**
 * Steps 2-12: one task, start to finish, under one exclusive lock.
 *
 * The lock is taken BEFORE the first write and held until the executor is dead, which is the
 * single most important ordering in this file. The resource needing protection is now the
 * user's own checkout, and it starts being modified at step 4 (rescue) and step 5 (branch), so
 * a lock taken at dispatch time would let two concurrent runs commit and switch branches over
 * each other while neither yet held anything. The existing queue path already got this right
 * (gateQueue takes the lock before it so much as checks for dirt), and this follows it.
 *
 * The heartbeat runs out of process on purpose -- see io/heartbeat.ts. Verify commands block
 * this event loop for the whole build, so an in-process beat would go silent for exactly as
 * long as the lock's 90-second staleness window, and someone else would take over the checkout
 * mid-run.
 */
export async function dispatchTask(deps: DispatchDeps, id: string): Promise<RunResult> {
  const { paths } = deps;
  const gateConfig = loadGateConfig(paths);
  // acquireLock has already reaped any orphan executor left by a dead holder (step 3) -- it
  // will not hand back a handle while one is still writing to this checkout.
  const lock = takeCheckoutLock(paths, gateConfig.lock_wait_minutes ?? 0);
  return withCheckoutLock(lock, async (envelope) => {
    const prep = prepareRun(deps, id);
    return runPrepared(deps, prep, gateConfig, envelope);
  });
}

/**
 * Run `body` while holding `lock`, with the out-of-process heartbeat running and the executor's
 * process group published into the lock -- then kill that group BEFORE releasing.
 *
 * Extracted because `resume` had none of it (review finding 6). Both paths start an executor in
 * the user's own checkout, so both need the same envelope; having it inline in one of them was
 * what let the other quietly do without.
 */
async function withCheckoutLock(
  lock: LockHandle,
  body: (envelope: RunEnvelope) => Promise<RunResult>,
): Promise<RunResult> {
  const beater = startHeartbeat(lock.path, lock.ownerToken);
  let execPgid: number | null = null;
  try {
    return await body({
      onExecPgid: (pgid) => {
        execPgid = pgid;
        lock.recordExecPgid(pgid);
      },
      stillOwned: () => ownsLock(lock.path, lock.ownerToken),
    });
  } finally {
    // Step 12, in this order: kill the executor's process group, THEN release the lock. The
    // supervisor already signals the group when the leader exits, but that is best effort and
    // non-blocking; this is the point where "no writer is left in this checkout" has to be true,
    // because the next line lets somebody else in.
    if (execPgid !== null) killProcessGroup(execPgid, 'SIGKILL');
    beater.stop();
    lock.release();
  }
}

/** Take the checkout lock, or throw CheckoutBusyError naming the holder. */
function takeCheckoutLock(paths: RouterPaths, waitMinutes: number): LockHandle {
  const lock = acquireLock(paths.gateLock(), { waitMs: waitMinutes * 60_000 });
  if ('blocked' in lock) {
    const held = lock.holder;
    throw new CheckoutBusyError(
      `the checkout is held by pid ${held?.pid ?? 'unknown'}` +
        (held ? `, last active ${new Date(held.beatAtMs).toISOString()}` : '') +
        `; router runs one task at a time`,
      held?.pid ?? null,
      held?.beatAtMs ?? null,
    );
  }
  return lock;
}

/**
 * Run a list of tasks ONE AT A TIME, in the given order.
 *
 * Concurrency is gone on purpose, and not because it cost anything to run: measured, the
 * whole orchestration overhead was 0.26s against 393s of executor time. It cost the human.
 * Several executors editing at once means tracking who changed what, in what order things
 * merge, and whether merging them breaks each other -- and every result still needs reviewing
 * one at a time, so the review, not the machine, was the bottleneck the parallelism fed.
 *
 * Each task is prepared immediately before it runs rather than all up front: under the branch
 * model preparing a task takes the checkout, so preparing five would leave four tasks pointing
 * at branches created from a HEAD that later tasks have already moved.
 */
export async function dispatchTasks(deps: DispatchDeps, ids: readonly string[]): Promise<RunResult[]> {
  const { paths } = deps;
  if (ids.length === 0) throw new Error('cannot dispatch an empty task list');
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`);
    seen.add(id);
  }

  // Where the batch started. Each task is cut from HERE, not from the previous task's tip.
  //
  // Stacking was the earlier behaviour and it was wrong in a way the scope gate hid: task 2's
  // recorded diff correctly contained only its own files, because that is computed from its own
  // base_sha -- but its BRANCH contained task 1's commits. So `land p2` alone merged p1 as well,
  // silently, past p1's own review and past the explicit land decision that is supposed to be
  // the user's. PLAN §5.3 never listed that as an accepted limit.
  //
  // A branch NAME is not enough to record that, which is what the follow-up review found: a
  // batch started from a detached HEAD had nothing to restore, so it stacked exactly as before.
  // The baseline is a ref: the branch when there is one, the commit itself when there is not.
  const startedOnBranch = currentBranch(paths.repoRoot);
  const baseline = startedOnBranch ?? resolveCommit(paths.repoRoot, 'HEAD');
  const gateConfig = loadGateConfig(paths);
  const results: RunResult[] = [];
  const faults: { id: string; message: string }[] = [];
  for (const [index, id] of ids.entries()) {
    try {
      // Inside the try, and this matters: restoring used to sit outside it, so a starting branch
      // deleted between tasks threw straight out of the loop -- past the fault list, past the
      // error that names which task failed and why -- and left the user standing on the previous
      // task's branch with no explanation.
      if (index > 0) restoreBaseline(deps, gateConfig.lock_wait_minutes ?? 0, baseline);
      results.push(await dispatchTask(deps, id));
    } catch (e) {
      faults.push({ id, message: e instanceof Error ? e.message : String(e) });
      break; // serial: a failure means the checkout state is unknown, so do not start the next
    }
  }
  if (faults.length > 0) {
    throw new Error(`dispatch runs failed: ${faults.map((f) => `${f.id}: ${f.message}`).join('; ')}`);
  }
  return results;
}

/**
 * Put the checkout back on the batch's starting ref before the next task cuts its branch.
 *
 * Under the exclusive lock, because this writes the user's checkout and everything that does
 * has to -- it is the same rule `prepareRun` follows, and this call used to sit outside it.
 * Refuses on a dirty tree rather than dragging the previous task's leftovers onto a new base.
 */
function restoreBaseline(deps: DispatchDeps, waitMinutes: number, ref: string): void {
  const { paths } = deps;
  const lock = takeCheckoutLock(paths, waitMinutes);
  try {
    const leftover = uncommittedSourceFiles(paths.repoRoot, ROUTER_STATE_EXCLUDE);
    if (leftover.length > 0) {
      throw new Error(
        `the checkout still has uncommitted changes from the previous task ` +
          `(${leftover.slice(0, 5).join(', ')}${leftover.length > 5 ? ', …' : ''}); ` +
          `commit or discard them before the batch continues`,
      );
    }
    checkoutRef(paths.repoRoot, ref);
  } finally {
    lock.release();
  }
}

/**
 * Resume a prior dispatch's executor session with follow-up feedback, instead of a
 * cold restart -- the executor keeps its context, so the retry is cheaper. Continues on the
 * SAME task branch. Fail-loud continuity guard: if the resumed run reports a different
 * session id than the prior run, we do NOT verify -- a fresh session is not a resume, and
 * silently treating it as one would defeat the point.
 *
 * The precondition used to be "the worktree directory still exists". It is now "the branch
 * still exists, and we are on it": the work lives in git rather than in a directory, so a
 * missing branch is the real "nothing to resume", and being on some OTHER branch is a
 * refusal rather than something to silently correct.
 */
export async function resumeTask(deps: DispatchDeps, id: string, feedback: string): Promise<RunResult> {
  const { paths } = deps;
  // Review finding 6: resume ran an executor in the user's checkout with NO transaction at all --
  // no lock, no heartbeat, no published process group, no identity assertion before verification,
  // and without reading gate.yaml. Measured by the reviewer: a fresh dispatch was FAILED by a
  // deliberately failing gate while a resume on the same fixture reported PASSED, because it
  // verified with `task.verify` and never saw the gate. It could also run concurrently with a
  // dispatch, both writing the same files.
  const gateConfig = loadGateConfig(paths);
  const lock = takeCheckoutLock(paths, gateConfig.lock_wait_minutes ?? 0);
  return withCheckoutLock(lock, (envelope) => resumeInLock(deps, id, feedback, gateConfig, envelope));
}

async function resumeInLock(
  deps: DispatchDeps,
  id: string,
  feedback: string,
  gateConfig: GateConfig,
  envelope: RunEnvelope,
): Promise<RunResult> {
  const { paths } = deps;
  const prev = store.readResult(paths, id);
  if (prev === null) throw new Error(`no prior dispatch for ${id}; run \`router dispatch ${id}\` first`);
  const priorSession = prev.session_id ?? null;
  if (!priorSession) throw new Error(`prior run for ${id} has no session id; resume unavailable -- re-dispatch instead`);
  const workDir = paths.repoRoot;
  const branch = prev.branch ?? taskBranch(id);
  if (!branchExists(workDir, branch)) {
    throw new Error(`branch ${branch} for ${id} is gone; resume unavailable -- re-dispatch instead`);
  }
  const baseSha = prev.base_sha ?? resolveCommit(workDir, branch);
  // Fault-injection case 8e: the user checked something else out between the dispatch and the
  // resume. Continuing here would run the executor against the wrong tree and then verify a
  // diff that has nothing to do with the task.
  assertTaskIdentity(workDir, { branch, baseSha });
  const refPath = branchRefPath(workDir, branch);

  const { task } = loadTask(paths, id);
  // Resume replays the prior run's exact executor pin (model + effort) so it
  // re-attaches with the same model it dispatched under.
  const used: WorkerPolicy = {
    kind: prev.worker.kind,
    ...(prev.worker.model ? { model: prev.worker.model } : {}),
    ...(prev.worker.effort ? { effort: prev.worker.effort } : {}),
  };
  const launcher = makeLauncher(used);
  const logPath = paths.workerLog(id);
  writeFileSync(logPath, '');
  const verifyEnv = buildWorkerEnv(process.env);
  const executorEnv = buildExecutorEnv(process.env, used.api_key_env ? [used.api_key_env] : []);
  // Must NOT 11 detection, which resume did not have at all. A fresh dispatch caught a forged
  // `.router/tasks/<other>/result.json` and failed; the identical write through a resume was
  // reported PASSED, because nothing on this path ever looked.
  const stateBefore = fingerprintState(paths, id);

  const o = await superviseWorker({
    argv: launcher.buildResumeArgv(workDir, priorSession, feedback, task),
    cwd: workDir,
    env: executorEnv,
    logPath,
    heartbeatPath: paths.heartbeat(id),
    watchPaths: [refPath],
    maxWallMs: task.max_wall_minutes * 60_000,
    stallMs: (used.stall_minutes ?? STALL_MINUTES_DEFAULT) * 60_000,
    onPgid: envelope.onExecPgid,
  });
  const log = safeRead(logPath);
  const exitClass: ExitClass = reclassifyEnvironmentFailure(reclassifyQuota(o.exitClass, log), log);
  const parsed: ParsedLog = (launcher.parseLog ?? parseCodexLog)(log);
  const conflict = detectContractConflict(parsed.finalMessage);
  const newSession = parsed.sessionId ?? null;
  // A resume that reports NO session id is not proof of re-attachment either. Measured: a
  // resume invoked with a flag the CLI rejects dies before starting and reports none at all,
  // and the old guard read that absence as agreement -- so it would have committed work under
  // a continuity claim nothing supported. A real resume does report the id, so absence means
  // something went wrong.
  const mismatch = newSession !== priorSession;

  const tampering = stateDiff(stateBefore, fingerprintState(paths, id));
  if (!envelope.stillOwned()) {
    tampering.push('modified gate.lock (it no longer carries this run’s owner token)');
  }

  const model = parsed.model ?? used.model;
  const costUsd = parsed.costUsd ?? null;
  const modelMismatch = exitClass !== 'ok' && !conflict && detectModelMismatch(log);
  const blocked =
    conflict || mismatch || o.groupSurvived || tampering.length > 0 || exitClass !== 'ok';
  const result: RunResult = {
    task_id: id,
    attempt_number: prev.attempt_number + 1,
    exit_class: conflict ? 'contract_conflict' : blocked ? 'task_failed' : exitClass,
    rc: o.rc,
    timed_out: o.timedOut,
    stalled: o.stalled,
    env_error: exitClass === 'env_error',
    started_at: new Date(o.startedAtMs).toISOString(),
    ended_at: new Date(o.endedAtMs).toISOString(),
    wall_seconds: Math.round((o.endedAtMs - o.startedAtMs) / 1000),
    worker: workerRecord(used, model),
    base_sha: baseSha,
    branch,
    resumed: true,
    session_id: newSession ?? priorSession,
    ...(mismatch ? { resume_session_mismatch: true, resume_reported_session: newSession } : {}),
    ...(o.groupSurvived ? { executor_group_survived: true } : {}),
    ...(tampering.length > 0 ? { state_tampering: tampering } : {}),
    ...(modelMismatch ? { model_mismatch: true } : {}),
    ...(conflict ? { conflict: true } : {}),
    ...(parsed.commandsRun !== undefined ? { commands_run: parsed.commandsRun } : {}),
    ...(parsed.usage !== null ? { tokens: { input: parsed.usage.input, output: parsed.usage.output } } : {}),
    ...(costUsd !== null ? { cost_usd: costUsd } : {}),
  };
  const delivery = persistDelivery(paths, id, task, parsed.finalMessage);
  if (delivery !== undefined) result.delivery = delivery;
  if (conflict) rmSync(paths.diffPatch(id), { force: true });
  // A run that did not end `ok` is never committed, so its work would otherwise look lost.
  // Say plainly that it is still on disk: an executor killed after it had already finished is
  // recoverable, and silently discarding that work is the worse failure.
  if (result.exit_class !== 'ok') {
    const leftoverOnFailure = uncommittedSourceFilesOrUnknown(workDir, ROUTER_STATE_EXCLUDE);
    if (leftoverOnFailure !== null && leftoverOnFailure.length > 0) result.uncommitted_changes = true;
  }

  // Everything from here to the single writeResult below is wrapped, and that is the whole
  // point. This block used to be able to throw -- `uncommittedSourceFiles` now reports a broken
  // index by throwing rather than by answering "clean", and assertTaskIdentity, rawDiff and the
  // verifier can all fail too. A throw here left resume with no record of the attempt at all,
  // while the resumed executor's commits sat on the branch and the PREVIOUS run's PASSED
  // result.json still pointed at it. Measured: resume exited 1, and `router land` then merged
  // `x = 3` into main on the strength of a verdict that had never seen it. Turning a fail-open
  // into a fail-closed check is only half the job; the other half is that the failure has to be
  // written down.
  if (!blocked) {
    try {
      // Same closing invariant as a fresh dispatch: the executor commits its own units, so a
      // leftover file means the work is not finished, not that we should sweep it up.
      const leftover = uncommittedSourceFiles(workDir, ROUTER_STATE_EXCLUDE);
      if (leftover.length > 0) {
        result.exit_class = 'task_failed';
        result.closeout = {
          ok: false,
          reason: 'uncommitted source files remain after resume; the executor did not commit its last unit',
          files: leftover,
        };
      } else {
        // Same identity assertion the fresh path makes before it verifies. Resume checked identity
        // once BEFORE launching the executor and never again, so an executor (or a human) that moved
        // the branch mid-run would have had its diff verified against the wrong base.
        assertTaskIdentity(workDir, { branch, baseSha });
        result.closeout = { ok: true };
        const patch = rawDiff(workDir, baseSha, 'HEAD');
        writeFileSync(paths.diffPatch(id), patch);
        result.diff_sha = createHash('sha256').update(patch).digest('hex');
        result.verified_head = resolveCommit(workDir, 'HEAD');
        result.verifier = verifyTask({
          repoRoot: paths.repoRoot,
          workDir,
          baseSha,
          head: 'HEAD',
          allowedGlobs: task.allowed_globs,
          ...(task.forbidden_globs !== undefined ? { forbiddenGlobs: task.forbidden_globs } : {}),
          ...(task.max_changed_lines !== undefined ? { maxChangedLines: task.max_changed_lines } : {}),
          verify: task.verify ?? [],
          env: verifyEnv,
          uncommittedExclude: ROUTER_STATE_EXCLUDE,
          // The project's gate, which resume used to skip entirely -- so a resume could report
          // PASSED on a diff the same gate had just FAILED on a fresh dispatch.
          gate: gateConfig,
          gateEnv: buildWorkerEnv(process.env, gateConfig.env ?? []),
        });
        attachEffectiveRisk(result, task, workDir, baseSha);
      }
    } catch (error) {
      // The attempt is recorded as failed and NOT verified. Rethrowing instead would leave the
      // branch ahead of a stale PASSED record, which is the merge hazard this catch exists for.
      result.exit_class = 'task_failed';
      result.closeout = { ok: false, reason: (error as Error).message, files: [] };
      delete result.verifier;
      delete result.verified_head;
      delete result.diff_sha;
    }
  }

  store.writeResult(paths, id, result);
  appendMetric(deps, result, task, null);
  return result;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function persistDelivery(
  paths: RouterPaths,
  id: string,
  task: TaskYaml,
  finalMessage: string | null | undefined,
): RunResult['delivery'] | undefined {
  if (finalMessage == null || finalMessage.length === 0) return undefined;

  const path = paths.delivery(id);
  try {
    writeFileSync(path, finalMessage);
  } catch (e) {
    // The report is auxiliary evidence; failing to store it must never cost the run its
    // result. Surface the failure instead of throwing it up through the dispatch.
    return { path, header: null, header_error: `write failed: ${(e as Error).message}` };
  }
  const header = parseDeliveryHeader(finalMessage);
  if (header === null) {
    return {
      path,
      header: null,
      header_error: finalMessage.includes('```router-delivery') ? 'invalid' : 'missing',
    };
  }

  const errors = deliveryHeaderMismatches(header, id, task.plan_revision);
  return {
    path,
    header,
    ...(errors.length > 0 ? { header_error: errors.join('; ') } : {}),
  };
}

function deliveryHeaderMismatches(
  header: DeliveryHeader,
  taskId: string,
  planRevision: string | undefined,
): string[] {
  const errors: string[] = [];
  if (header.task !== taskId) errors.push(`task mismatch: expected ${taskId}, got ${header.task}`);
  // Compare against the revision the contract declares, not the plan id: comparing the id to
  // itself could never disagree, so this check proved nothing until now.
  if (planRevision !== undefined && header.plan_revision !== undefined && header.plan_revision !== planRevision) {
    errors.push(`plan_revision mismatch: expected ${planRevision}, got ${header.plan_revision}`);
  }
  return errors;
}

function attachEffectiveRisk(result: RunResult, task: TaskYaml, workDir: string, baseSha: string): void {
  if (result.verifier?.result !== 'PASSED') return;
  const changes = collectDiff(workDir, baseSha, 'HEAD');
  const changedPaths = changes.flatMap((change) =>
    change.oldPath === undefined ? [change.path] : [change.oldPath, change.path],
  );
  const assessed = effectiveRisk(task.risk, {
    changedLines:
      result.verifier.changed_lines ??
      changes.reduce((total, change) => total + (change.binary ? 0 : change.added + change.deleted), 0),
    changedPaths,
    invariantGlobs: task.invariants ?? [],
  });
  result.risk = assessed.risk;
  result.risk_raised_by = assessed.raisedBy;
}

function appendMetric(
  deps: DispatchDeps,
  result: RunResult,
  task: TaskYaml,
  context: TaskContext | null,
  phaseTimings?: RunPhaseTimings,
): void {
  const metric: MetricRecord = {
    ts: deps.clock.nowIso(),
    task_id: result.task_id,
    ...(task.plan_id !== undefined ? { plan_id: task.plan_id } : {}),
    ...(task.plan_revision !== undefined ? { plan_revision: task.plan_revision } : {}),
    task_context_present: context !== null,
    task_context_chars: context?.chars ?? 0,
    ...(context !== null
      ? {
          task_context_sha256: context.sha256,
          context_base_sha: context.base_sha,
        }
      : {}),
    role: 'executor',
    run_id: RUN_LABEL,
    attempt_number: 1,
    model: result.worker.model ?? null,
    executor: result.worker.kind,
    ...(task.tier !== undefined ? { tier: task.tier } : {}),
    ...(result.worker.effort !== undefined ? { effort: result.worker.effort } : {}),
    ...(result.risk !== undefined ? { risk: result.risk } : {}),
    conflict: result.conflict ?? false,
    ...(result.commands_run !== undefined ? { commands_run: result.commands_run } : {}),
    exit_class: result.exit_class,
    verifier_result: result.verifier?.result ?? null,
    first_pass: result.verifier?.result === 'PASSED',
    tokens_input: result.tokens?.input ?? null,
    tokens_output: result.tokens?.output ?? null,
    cost_usd: result.cost_usd ?? null,
    wall_seconds: result.wall_seconds,
    ...(phaseTimings ?? {}),
    escalated: false,
    env_error: result.env_error,
  };
  store.appendMetric(deps.paths, metric);
}
