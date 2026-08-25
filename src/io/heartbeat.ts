// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

// A JSON-file heartbeat that runs in its OWN PROCESS, because an in-process one cannot work here.
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
// Three exit conditions, all of them "stop beating a file we should not be keeping alive":
// the parent is gone, the file no longer parses, or an ownership guard no longer matches. The
// parent check is the important one: a heartbeat that outlived its owner would keep a dead
// activity or lock looking fresh forever.
//
// Writes IN PLACE -- open 'r+', write, truncate -- for two reasons. The inode survives, so
// LockHandle's identity check still holds; and there is no moment when the file is empty, which
// `writeFileSync` would create by truncating on open. The narrowest window a reader can hit is
// therefore a mix of two documents rather than a zero-byte file. Activity timestamps are fixed
// width, so their mix remains a complete JSON document; lock readers already retry a torn read.
//
// It still is a window. Readers must treat an unparseable lock as "re-read and decide again",
// never as proof of staleness -- which is what acquireLock does before it reclaims anything.
const CHILD_SOURCE = `
const fs = require('node:fs');
const [filePath, field, valueFormat, guardRaw, indentRaw, intervalRaw, parentRaw, pauseReady, pauseResume, pauseDone] = process.argv.slice(1);
const indent = Number(indentRaw);
const interval = Number(intervalRaw);
const parentPid = Number(parentRaw);
let guard;
try { guard = JSON.parse(guardRaw); } catch { process.exit(0); }
function beat() {
  if (process.ppid !== parentPid) process.exit(0);
  try { process.kill(parentPid, 0); } catch { process.exit(0); }
  let fd;
  try { fd = fs.openSync(filePath, 'r+'); } catch { process.exit(0); }
  try {
    let stored;
    try { stored = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { process.exit(0); }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) process.exit(0);
    for (const [key, value] of Object.entries(guard)) {
      if (!Object.prototype.hasOwnProperty.call(stored, key) || stored[key] !== value) process.exit(0);
    }
    if (pauseReady) {
      try {
        fs.writeFileSync(pauseReady, 'ready');
        while (!fs.existsSync(pauseResume)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      } catch { process.exit(0); }
    }
    stored[field] = valueFormat === 'iso' ? new Date().toISOString() : Date.now();
    const data = Buffer.from(JSON.stringify(stored, null, indent) + '\\n');
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
      if (written === 0) process.exit(0);
      offset += written;
    }
    fs.ftruncateSync(fd, data.length);
    if (pauseDone) {
      try { fs.writeFileSync(pauseDone, 'done'); } catch { process.exit(0); }
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}
beat();
setInterval(beat, interval);
`;

export type HeartbeatValueFormat = 'milliseconds' | 'iso';

export type HeartbeatGuardValue = string | number | boolean | null;

export interface JsonHeartbeatOptions {
  /** The top-level field to refresh. */
  field: string;
  /** Whether the refreshed value is epoch milliseconds or an ISO-8601 string. */
  valueFormat: HeartbeatValueFormat;
  /** Fields that must still match before every write, proving this file is still ours. */
  guard: Readonly<Record<string, HeartbeatGuardValue>>;
  /** JSON indentation used by lifecycle writes; matching it keeps each heartbeat the same size. */
  indent?: number;
  intervalMs?: number;
  /** Fault-injection handshake used only to prove the open/read/write inode interleaving. */
  testPauseAfterRead?: { readyPath: string; resumePath: string; donePath: string };
}

/**
 * Refresh one top-level field of a JSON object from a separate process.
 *
 * The child stops when its parent disappears, the document is missing or malformed, or any
 * guard field changes. Writes deliberately preserve the inode and avoid a truncate-on-open
 * window; callers use atomic replacement for lifecycle writes and guards stop an old child from
 * refreshing a replacement document.
 */
export function startJsonHeartbeat(
  filePath: string,
  options: JsonHeartbeatOptions,
): HeartbeatHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_BEAT_MS;
  const child = spawn(
    process.execPath,
    [
      '-e',
      CHILD_SOURCE,
      filePath,
      options.field,
      options.valueFormat,
      JSON.stringify(options.guard),
      String(options.indent ?? 0),
      String(intervalMs),
      String(process.pid),
      options.testPauseAfterRead?.readyPath ?? '',
      options.testPauseAfterRead?.resumePath ?? '',
      options.testPauseAfterRead?.donePath ?? '',
    ],
    { detached: true, stdio: 'ignore' },
  );
  // Detached and unref'd so the parent neither waits on it nor drags it down mid-write when a
  // terminal signal hits the parent's process group. The child owns its parent-pid check.
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
  return startJsonHeartbeat(lockPath, {
    field: 'beatAtMs',
    valueFormat: 'milliseconds',
    guard: { ownerToken },
    intervalMs,
  });
}
