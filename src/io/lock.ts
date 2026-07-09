// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

// Global mutual-exclusion lock for state mutations. Held only for millisecond-
// scale critical sections (a transition / registry write) - NEVER for the
// lifetime of a worker (that exclusivity is the max_concurrent_workers slot +
// lease). See design doc D5.
//
// Winner selection relies solely on mkdir() atomicity: at most one caller can
// create the lock directory. Everything else (pid-liveness, mtime TTL) exists
// only to reclaim a lock abandoned by a dead/hung/pid-reused owner.
//
// Assumes a local filesystem - mtime-based staleness is unreliable on NFS.

export interface LockOptions {
  /** A lock older than this (by dir mtime) is considered abandoned. */
  staleMs?: number;
  /** Give up acquiring after this long. */
  timeoutMs?: number;
  /** Backoff between acquire attempts. */
  retryMs?: number;
}

export interface LockHandle {
  lockDir: string;
  nonce: string;
}

interface OwnerInfo {
  pid: number;
  host: string;
  nonce: string;
  acquiredAt: string;
}

const DEFAULTS = { staleMs: 30_000, timeoutMs: 10_000, retryMs: 20 };

export class LockTimeoutError extends Error {
  constructor(lockDir: string, ms: number) {
    super(`could not acquire lock ${lockDir} within ${ms}ms`);
    this.name = 'LockTimeoutError';
  }
}

/** Block the current thread for `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let nonceCounter = 0;
function makeNonce(): string {
  nonceCounter += 1;
  return `${process.pid}-${nonceCounter}-${process.hrtime.bigint()}`;
}

/** True if `pid` appears to be a live process on this host. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process
    if (code === 'EPERM') return true; // exists but we can't signal it
    return true; // conservative: assume alive on unexpected errors
  }
}

const ownerFile = (lockDir: string): string => join(lockDir, 'owner.json');

function readOwner(lockDir: string): OwnerInfo | null {
  try {
    return JSON.parse(readFileSync(ownerFile(lockDir), 'utf8')) as OwnerInfo;
  } catch {
    return null; // mid-acquire race, or malformed - caller treats as transient
  }
}

function dirAgeMs(lockDir: string): number | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

function isStale(lockDir: string, staleMs: number): boolean {
  const owner = readOwner(lockDir);
  const age = dirAgeMs(lockDir);
  // Owner file unreadable but dir present: only reclaim if clearly old.
  if (owner === null) return age !== null && age > staleMs;
  const sameHost = owner.host === hostname();
  const pidDead = sameHost && !isProcessAlive(owner.pid);
  const tooOld = age !== null && age > staleMs;
  // Dead pid (same host) -> reclaim. Otherwise only reclaim on TTL, which also
  // covers pid-reuse (alive pid that isn't really our owner) and cross-host.
  return pidDead || tooOld;
}

export function acquireLock(lockDir: string, opts: LockOptions = {}): LockHandle {
  const staleMs = opts.staleMs ?? DEFAULTS.staleMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const retryMs = opts.retryMs ?? DEFAULTS.retryMs;
  const nonce = makeNonce();
  const deadline = Date.now() + timeoutMs;
  // The lock dir's parent (.router) must exist; init creates it in production,
  // but make acquisition robust when it doesn't. The lock dir ITSELF is created
  // non-recursively below - that mkdir is the atomic mutual-exclusion primitive.
  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDir); // atomic; EEXIST if already held
      const info: OwnerInfo = {
        pid: process.pid,
        host: hostname(),
        nonce,
        acquiredAt: new Date().toISOString(),
      };
      writeFileSync(ownerFile(lockDir), `${JSON.stringify(info)}\n`);
      return { lockDir, nonce };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Held by someone. Reclaim if abandoned, else back off.
      if (isStale(lockDir, staleMs)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another reclaimer got there first; loop and re-mkdir */
        }
        continue; // race to re-create immediately (mkdir picks one winner)
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockDir, timeoutMs);
      sleepSync(retryMs);
    }
  }
}

export function releaseLock(handle: LockHandle): void {
  // Only remove the lock if we still own it (we may have been reclaimed while
  // holding - pathological, but never delete a live owner's lock).
  const owner = readOwner(handle.lockDir);
  if (owner !== null && owner.nonce !== handle.nonce) return;
  try {
    rmSync(handle.lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Run `fn` while holding the global lock; always releases, even on throw. */
export function withGlobalLock<T>(lockDir: string, fn: () => T, opts?: LockOptions): T {
  const handle = acquireLock(lockDir, opts);
  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}
