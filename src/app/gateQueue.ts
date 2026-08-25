// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../io/clock.ts';
import type { GateResult, RunResult } from '../domain/types.ts';
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
import { acquireLock, ownsLock, type LockHandle } from '../io/lock.ts';
import { startHeartbeat } from '../io/heartbeat.ts';
import { taskBranch, type RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import * as store from '../io/store.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';
import { pinnedHead } from './verifiedHead.ts';
import { loadGateConfig, selectGate } from './gateConfig.ts';

export interface GateQueueDeps {
  paths: RouterPaths;
  clock: Clock;
}

const LOCK_WAIT_MINUTES_DEFAULT = 60;
const GATE_WALL_MINUTES_DEFAULT = 180;
const LOCK_HEARTBEAT_MS = 20_000;

function persistGate(
  paths: RouterPaths,
  taskId: string,
  result: RunResult,
  gate: GateResult,
): GateResult {
  result.gate = gate;
  store.writeResult(paths, taskId, result);
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

  const result = store.readResult(paths, taskId);
  if (result === null) return { ok: false, reason: 'result_missing' };
  if (result.exit_class === 'contract_conflict') {
    return { ok: false, reason: 'contract_conflict' };
  }
  if (result.verifier?.result !== 'PASSED') {
    return { ok: false, reason: 'verifier_not_passed' };
  }

  // The branch the run recorded, falling back to the derived name for records written before
  // the field existed. `run_branch_missing` keeps its wire name: it is a reported reason string
  // that callers and tests match on, and renaming it would break them to say the same thing.
  const branch = result.branch ?? taskBranch(taskId);
  if (!branchExists(paths.repoRoot, branch)) {
    return { ok: false, reason: 'run_branch_missing' };
  }
  // The same head pin `router land` applies, because this is the OTHER path that merges a run
  // branch on the strength of a stored PASSED. The first version of that fix went into `land`
  // alone, which left the identical hole open one command away: this gate merged the branch's
  // CURRENT tip into the integration branch, and it does not re-run scope or secret-scan, so a
  // commit appended after the verdict reached the integration branch unexamined.
  const pin = pinnedHead(paths.repoRoot, branch, result);
  if (!pin.ok) return { ok: false, reason: 'head_not_verified', detail: pin.reason };

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
  let beater: { stop(): void } | undefined;

  const stopHeartbeat = (): void => {
    beater?.stop();
    beater = undefined;
  };

  // Out of process, for the reason io/heartbeat.ts documents: gate commands run through
  // spawnSync, so this event loop is blocked for the whole build and an in-process
  // `setInterval` beat -- which is what stood here -- goes silent for exactly as long as the
  // lock's 90-second staleness window. A gate is the longest thing router runs.
  const beginHeartbeat = (): void => {
    beater = startHeartbeat(lock.path, lock.ownerToken, LOCK_HEARTBEAT_MS);
  };

  // The beater exits on its own when the lock stops naming us, but it has no way to say so, so
  // the fail-loud check has to be a question we ask between steps. Losing the lock mid-gate
  // means someone else is in this checkout; killing our own gate is the correct response.
  const assertStillOurs = (): void => {
    if (heartbeatError !== undefined) return;
    if (ownsLock(lock.path, lock.ownerToken)) return;
    heartbeatError = new Error(`lost the gate lock ${lock.path} mid-gate; another holder took over`);
    if (currentPgid !== undefined) {
      try {
        killProcessGroup(currentPgid, 'SIGTERM');
      } catch {
        /* the recorded error is reported after supervision settles */
      }
    }
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
      heartbeatPath: paths.heartbeat(taskId),
      watchPaths: [paths.repoRoot, join(paths.repoRoot, '.git')],
      maxWallMs,
      stallMs: maxWallMs,
      onPgid: (pgid) => {
        currentPgid = pgid;
      },
    });
    currentPgid = undefined;
    assertStillOurs();
    if (heartbeatError !== undefined) throw heartbeatError;
    // A gate command whose process group outlived SIGKILL is still able to write this checkout,
    // so the next command's result would not be about the tree we think it is. `groupSurvived`
    // was wired into dispatch and nowhere else; this is the other caller.
    if (outcome.groupSurvived) {
      throw new Error(
        `a gate command left a process group that survived SIGKILL; refusing to continue in a ` +
          `checkout something else is still writing`,
      );
    }
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
      mergeNoFF(paths.repoRoot, pin.sha, `Merge branch '${branch}'`);
    } catch {
      mergeAbort(paths.repoRoot);
      resetHardTracked(paths.repoRoot, baseSha);
      return persistGate(paths, taskId, result, {
        ok: false,
        reason: 'apply_conflict',
      });
    }
    mergeSha = resolveCommit(paths.repoRoot, 'HEAD');

    const changes = collectDiff(paths.repoRoot, baseSha, 'HEAD');
    const selected = selectGate(config, changes);
    if (selected === null) throw new Error('configured gate has no commands');
    const { level, commands } = selected;
    const gateLog = paths.gateLog(taskId);
    const maxWallMs = (config.gate_wall_minutes ?? GATE_WALL_MINUTES_DEFAULT) * 60_000;
    const env = buildWorkerEnv(process.env, config.env ?? []);

    beginHeartbeat();
    try {
      const resetLog = `${gateLog}.reset`;
      for (const argv of config.reset ?? []) {
        const resetOutcome = await supervise(argv, resetLog, maxWallMs, env);
        if (resetOutcome.exitClass !== 'ok') {
          // The public evidence path exists but contains no gate output because
          // reset failure prevented every gate command from starting.
          writeFileSync(gateLog, '', { flag: 'a' });
          resetHardTracked(paths.repoRoot, baseSha);
          return persistGate(paths, taskId, result, {
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
          return persistGate(paths, taskId, result, {
            ok: false,
            reason: 'gate_failed',
            level,
            integration_branch: config.integration_branch!,
            base_sha: baseSha,
            head_sha: mergeSha,
            log: gateLog,
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
    persistGate(paths, taskId, result, gate);
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
