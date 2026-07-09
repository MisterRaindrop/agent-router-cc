// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import type { Lease } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';
import { isProcessAlive } from '../io/lock.ts';
import { killProcessGroup } from '../io/signals.ts';
import * as store from '../io/store.ts';
import { rebuildRegistry } from './registry.ts';
import { currentState, transition, type TransitionDeps } from './transition.ts';

// Crash recovery. A worker is a detached process group whose fate lives on disk
// (lease + heartbeat). recover reconciles RUNNING tasks whose supervisor died or
// whose heartbeat went stale: it kills any lingering process group, then marks
// the run STALE. Runs from the SessionStart hook and manually - fully idempotent.

export interface RecoverOptions {
  /** A heartbeat older than this (ms) marks the run dead. Default 60s (3x interval). */
  heartbeatStaleMs?: number;
}

export interface RecoverResult {
  recovered: { id: string; run: string | null; reason: string }[];
  stillRunning: string[];
  reindexErrors: { id: string; error: string }[];
}

/** Returns a death reason, or null if the run appears healthy. */
function runDeadReason(
  paths: RouterPaths,
  id: string,
  lease: Lease | null,
  heartbeatStaleMs: number,
): string | null {
  if (lease === null) return 'no_lease';

  // Same host: the supervisor's pid liveness is authoritative. If it's alive, the
  // run is being managed - do NOT fall through to the heartbeat, because the
  // supervisor blocks its event loop during a synchronous build/test verify (which
  // can take minutes), freezing the heartbeat while the run is perfectly healthy.
  // The supervisor owns worker timeout/stall detection itself.
  if (lease.host === hostname()) {
    return isProcessAlive(lease.supervisor_pid) ? null : 'supervisor_dead';
  }

  // Cross-host: we cannot check the pid, so fall back to heartbeat + deadline.
  let heartbeatAgeMs: number | null = null;
  try {
    heartbeatAgeMs = Date.now() - statSync(paths.heartbeat(id, lease.run_id)).mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
  if (heartbeatAgeMs === null) return 'no_heartbeat';
  if (heartbeatAgeMs > heartbeatStaleMs) return 'heartbeat_stale';

  const deadline = Date.parse(lease.wall_deadline);
  if (Number.isFinite(deadline) && Date.now() > deadline) return 'wall_deadline_exceeded';

  return null;
}

export function recover(deps: TransitionDeps, opts: RecoverOptions = {}): RecoverResult {
  const { paths } = deps;
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? 60_000;

  // Repair projections first so we read authoritative state.
  const { errors: reindexErrors } = rebuildRegistry(deps);

  const recovered: RecoverResult['recovered'] = [];
  const stillRunning: string[] = [];

  for (const id of store.listTaskIds(paths)) {
    const st = currentState(paths, id);
    if (st === null || st.state !== 'RUNNING') continue;

    const run = st.current_run;
    const lease = run !== null ? store.readLease(paths, id, run) : null;
    const reason = runDeadReason(paths, id, lease, heartbeatStaleMs);

    if (reason === null) {
      stillRunning.push(id);
      continue;
    }

    // Best-effort: reap any lingering process group before marking STALE.
    // NOTE (known residual): we cannot verify the pgid still belongs to our
    // worker, so in the narrow case where the OS has reused a dead worker's pgid
    // this could signal an unrelated same-user group. Acceptable under the
    // "confused not adversarial" threat model; a start-time check would remove it.
    if (lease !== null) killProcessGroup(lease.worker_pgid, 'SIGKILL');
    transition(deps, id, 'STALE', {
      actor: 'recover',
      runId: run,
      meta: { reason: `router_crash:${reason}` },
    });
    recovered.push({ id, run, reason });
  }

  return { recovered, stillRunning, reindexErrors };
}
