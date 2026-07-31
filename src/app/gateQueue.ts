// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import type { Clock } from '../io/clock.ts';
import type { GateResult, RunResult } from '../domain/types.ts';
import { matchAny } from '../core/glob.ts';
import {
  branchExists,
  checkoutBranch,
  checkoutRef,
  collectDiff,
  currentRef,
  mergeAbort,
  mergeNoFF,
  resetHardTracked,
  resolveCommit,
  trackedChanges,
} from '../io/git.ts';
import { buildWorkerEnv } from '../io/env.ts';
import { acquireLock, type LockHandle } from '../io/lock.ts';
import { runBranch, runId, type RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import * as store from '../io/store.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';
import { loadGateConfig } from './gateConfig.ts';

export interface GateQueueDeps {
  paths: RouterPaths;
  clock: Clock;
}

const RUN = runId(1);
const LOCK_WAIT_MINUTES_DEFAULT = 60;
const GATE_WALL_MINUTES_DEFAULT = 180;
const LOCK_HEARTBEAT_MS = 20_000;

function persistGate(
  paths: RouterPaths,
  taskId: string,
  run: string,
  result: RunResult,
  gate: GateResult,
): GateResult {
  result.gate = gate;
  store.writeResult(paths, taskId, run, result);
  return gate;
}

/**
 * Borrow the real checkout long enough to verify one dispatched commit on the
 * current integration head. Restoration and lock release live in one `finally`
 * so every return and exception takes the same safety path.
 */
export async function runQueueGate(
  deps: GateQueueDeps,
  taskId: string,
): Promise<GateResult> {
  const { paths } = deps;
  const config = loadGateConfig(paths);
  if (config.mode !== 'queue') {
    throw new Error('runQueueGate requires gate mode "queue"');
  }

  const run = RUN;
  const result = store.readResult(paths, taskId, run);
  if (result === null) return { ok: false, reason: 'result_missing' };
  if (result.exit_class === 'contract_conflict') {
    return { ok: false, reason: 'contract_conflict' };
  }
  if (result.verifier?.result !== 'PASSED') {
    return { ok: false, reason: 'verifier_not_passed' };
  }

  const taskBranch = runBranch(taskId, run);
  if (!branchExists(paths.repoRoot, taskBranch)) {
    return { ok: false, reason: 'run_branch_missing' };
  }

  const acquired = acquireLock(paths.gateLock(), {
    waitMs: (config.lock_wait_minutes ?? LOCK_WAIT_MINUTES_DEFAULT) * 60_000,
  });
  if ('blocked' in acquired) {
    return {
      ok: false,
      reason: 'lock_unavailable',
      holder: acquired.holder,
    };
  }

  const lock: LockHandle = acquired;
  let originalRef: string | undefined;
  let baseSha: string | undefined;
  let mergeSha: string | undefined;
  let keepMerge = false;
  let currentPgid: number | undefined;
  let heartbeatError: Error | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const startHeartbeat = (): void => {
    heartbeatTimer = setInterval(() => {
      try {
        lock.heartbeat();
      } catch (err) {
        heartbeatError = err instanceof Error ? err : new Error(String(err));
        if (currentPgid !== undefined) {
          try {
            killProcessGroup(currentPgid, 'SIGTERM');
          } catch {
            /* the recorded heartbeat error is reported after supervision settles */
          }
        }
      }
    }, LOCK_HEARTBEAT_MS);
  };

  const supervise = async (
    argv: string[],
    logPath: string,
    maxWallMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<SupervisionOutcome> => {
    if (heartbeatError !== undefined) throw heartbeatError;
    currentPgid = undefined;
    const outcome = await superviseWorker({
      argv,
      cwd: paths.repoRoot,
      env,
      logPath,
      heartbeatPath: paths.heartbeat(taskId, run),
      watchDir: paths.repoRoot,
      maxWallMs,
      stallMs: maxWallMs,
      onPgid: (pgid) => {
        currentPgid = pgid;
      },
    });
    currentPgid = undefined;
    if (heartbeatError !== undefined) throw heartbeatError;
    return outcome;
  };

  try {
    // Only tracked modifications matter: a checkout or reset would overwrite those, while
    // untracked files and submodule build residue survive untouched.
    const dirty = trackedChanges(paths.repoRoot);
    if (dirty.length > 0) {
      return { ok: false, reason: 'checkout_dirty', dirty: dirty.slice(0, 10) };
    }

    originalRef = currentRef(paths.repoRoot);
    checkoutBranch(paths.repoRoot, config.integration_branch!);
    baseSha = resolveCommit(paths.repoRoot, 'HEAD');

    try {
      mergeNoFF(paths.repoRoot, taskBranch);
    } catch {
      mergeAbort(paths.repoRoot);
      resetHardTracked(paths.repoRoot, baseSha);
      return persistGate(paths, taskId, run, result, {
        ok: false,
        reason: 'apply_conflict',
      });
    }
    mergeSha = resolveCommit(paths.repoRoot, 'HEAD');

    const changes = collectDiff(paths.repoRoot, baseSha, 'HEAD');
    // Incremental builds can retain a stale object for a source file that no
    // longer exists, so every deletion forces the heavy gate.
    const useClean =
      config.clean_gate !== undefined &&
      (changes.some((entry) => entry.status === 'D') ||
        changes.some(
          (entry) =>
            matchAny(entry.path, config.clean_triggers ?? []) ||
            (entry.oldPath !== undefined && matchAny(entry.oldPath, config.clean_triggers ?? [])),
        ));
    const level: 'task' | 'clean' = useClean ? 'clean' : 'task';
    const commands = useClean ? config.clean_gate! : config.gate!;
    if (commands.length === 0) {
      throw new Error(`configured ${level === 'clean' ? 'clean_gate' : 'gate'} has no commands`);
    }
    const gateLog = paths.gateLog(taskId, run);
    const maxWallMs = (config.gate_wall_minutes ?? GATE_WALL_MINUTES_DEFAULT) * 60_000;
    const env = buildWorkerEnv(process.env, config.env ?? []);

    startHeartbeat();
    try {
      const resetLog = `${gateLog}.reset`;
      for (const argv of config.reset ?? []) {
        const resetOutcome = await supervise(argv, resetLog, maxWallMs, env);
        if (resetOutcome.exitClass !== 'ok') {
          // The public evidence path exists but contains no gate output because
          // reset failure prevented every gate command from starting.
          writeFileSync(gateLog, '', { flag: 'a' });
          resetHardTracked(paths.repoRoot, baseSha);
          return persistGate(paths, taskId, run, result, {
            ok: false,
            reason: 'reset_failed',
            level,
            integration_branch: config.integration_branch!,
            base_sha: baseSha,
            head_sha: mergeSha,
            log: gateLog,
            // The gate log is empty on purpose -- no gate command ran -- so the reason has
            // to be reachable, not stranded in an unreferenced sibling file.
            reset_log: resetLog,
            rc: resetOutcome.rc,
          });
        }
      }

      for (const argv of commands) {
        const gateOutcome = await supervise(argv, gateLog, maxWallMs, env);
        if (gateOutcome.exitClass !== 'ok') {
          resetHardTracked(paths.repoRoot, baseSha);
          // Was it already failing before this change? A lived-in checkout carries residue CI
          // never sees -- measured on a real ClickHouse tree, the project's own style gate
          // failed on symlinks under `ci/tmp` and `tmp/venv`, nothing to do with any diff.
          // Blaming the task for that sends its executor off to fix someone else's mess, so
          // the same command is re-run on the pre-merge head before any verdict is issued.
          // This costs a second run only when the gate has already failed.
          const baselineLog = `${gateLog}.baseline`;
          const baseline = await supervise(argv, baselineLog, maxWallMs, env);
          const preExisting = baseline.exitClass !== 'ok';
          return persistGate(paths, taskId, run, result, {
            ok: false,
            reason: preExisting ? 'gate_failed_pre_existing' : 'gate_failed',
            level,
            integration_branch: config.integration_branch!,
            base_sha: baseSha,
            head_sha: mergeSha,
            log: gateLog,
            ...(preExisting ? { baseline_log: baselineLog } : {}),
            rc: gateOutcome.rc,
          });
        }
      }
    } finally {
      stopHeartbeat();
    }

    // Discard tracked files (or commits) a gate command may have produced while
    // preserving every untracked build artifact in the warm checkout.
    resetHardTracked(paths.repoRoot, mergeSha);
    const gate: GateResult = {
      ok: true,
      level,
      integration_branch: config.integration_branch!,
      base_sha: baseSha,
      head_sha: mergeSha,
      log: gateLog,
    };
    persistGate(paths, taskId, run, result, gate);
    keepMerge = true;
    return gate;
  } finally {
    stopHeartbeat();
    let restorationError: unknown;
    if (originalRef !== undefined) {
      if (!keepMerge && baseSha !== undefined) {
        try {
          resetHardTracked(paths.repoRoot, baseSha);
        } catch (err) {
          restorationError = err;
        }
      }
      try {
        checkoutRef(paths.repoRoot, originalRef);
      } catch (err) {
        if (restorationError === undefined) restorationError = err;
      }
    }
    try {
      lock.release();
    } catch (err) {
      if (restorationError === undefined) restorationError = err;
    }
    if (restorationError !== undefined) throw restorationError;
  }
}
