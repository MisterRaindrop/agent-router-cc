// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

// A lock heartbeat that runs in its OWN PROCESS, because an in-process one cannot work here.
//
// The gate lock goes stale after 90s without a beat (io/lock.ts DEFAULT_STALE_MS) and the
// verify commands run through `spawnSync` (io/proc.ts) -- synchronous by design, so the whole
// event loop is blocked for as long as the build takes. A `setInterval` beat therefore does
// not fire at all during exactly the phase that lasts longest: measured on this repo,
// t_exec was 393s against a 90s threshold. The lock would be declared stale and taken over
// while its owner was still working in the checkout, which under the branch execution model
// means two dispatches editing the user's files at once.
//
// A worker thread was rejected: `spawnSync` blocks the calling *thread*, so a worker would
// survive, but it shares the process and dies with it -- and it would have to carry the whole
// lock module across the thread boundary to beat correctly. A child process is what actually
// decouples the two, and `node -e` keeps it to zero shipped files, which matters because the
// CLI is distributed as one bundled dist/router.js.

/** Beat well inside DEFAULT_STALE_MS (90s): six missed beats before anyone may take over. */
export const DEFAULT_BEAT_MS = 15_000;

export interface HeartbeatHandle {
  /** Stop beating. Idempotent; safe to call after the child already exited. */
  stop(): void;
  /** The beating child's pid, or null when it could not be started. */
  readonly pid: number | null;
}

// Runs in the child. Deliberately tiny and dependency-free -- it is a string, so the
// typechecker never sees it.
//
// Three exit conditions, all of them "stop beating a lock we should not be keeping alive":
// the parent is gone, the file no longer parses, or the owner token no longer matches. The
// parent check is the important one: a heartbeat that outlived its owner would keep a dead
// holder's lock looking fresh forever, and nobody could ever reclaim it.
//
// Writes in place (no rename), so the lock keeps its inode and LockHandle's identity check
// still holds. A reader that catches a torn write sees `corrupt`, which acquireLock already
// re-reads and re-decides on before reclaiming anything.
const CHILD_SOURCE = `
const fs = require('node:fs');
const [lockPath, token, intervalRaw, parentRaw] = process.argv.slice(1);
const interval = Number(intervalRaw);
const parentPid = Number(parentRaw);
function beat() {
  try { process.kill(parentPid, 0); } catch { process.exit(0); }
  let stored;
  try { stored = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { process.exit(0); }
  if (stored === null || typeof stored !== 'object' || stored.ownerToken !== token) process.exit(0);
  stored.beatAtMs = Date.now();
  try { fs.writeFileSync(lockPath, JSON.stringify(stored) + '\\n'); } catch { process.exit(0); }
}
beat();
setInterval(beat, interval);
`;

/**
 * Start beating `lockPath` from a separate process until `stop()` is called, the owner token
 * stops matching, or this process dies.
 *
 * `ownerToken` is the authority, not the pid: the child refuses to beat a lock that has been
 * reclaimed and re-created by somebody else, which is the same rule LockHandle.release()
 * follows for the same reason.
 */
export function startHeartbeat(
  lockPath: string,
  ownerToken: string,
  intervalMs: number = DEFAULT_BEAT_MS,
): HeartbeatHandle {
  const child = spawn(
    process.execPath,
    ['-e', CHILD_SOURCE, lockPath, ownerToken, String(intervalMs), String(process.pid)],
    { detached: true, stdio: 'ignore' },
  );
  // Detached and unref'd so the parent neither waits on it nor drags it down mid-write when a
  // terminal signal hits the parent's process group -- the parent still has a lock to release
  // at that point, and the child's own parent-pid check is what ends it if we never get there.
  child.unref();
  let stopped = false;
  const pid = child.pid ?? null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (pid === null) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  return {
    stop,
    get pid() {
      return pid;
    },
  };
}
