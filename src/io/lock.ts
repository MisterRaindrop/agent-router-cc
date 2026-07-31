// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

export interface LockInfo {
  pid: number;
  startedAtMs: number;
  beatAtMs: number;
  label?: string;
}

export interface LockHandle {
  path: string;
  release(): void;
  heartbeat(): void;
}

export interface AcquireOptions {
  waitMs: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
}

interface TakeoverInfo {
  atMs: number;
  reason: 'corrupt' | 'dead-pid' | 'stale-heartbeat';
  holder: LockInfo | null;
}

interface StoredLock extends LockInfo {
  ownerToken?: string;
  takeover?: TakeoverInfo;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

type LockRead =
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'valid'; info: LockInfo; stored: StoredLock };

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_POLL_MS = 100;
let ownerCounter = 0;

function ownerToken(): string {
  ownerCounter += 1;
  return `${process.pid}-${ownerCounter}-${process.hrtime.bigint()}`;
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function parseStored(text: string): { info: LockInfo; stored: StoredLock } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (!Number.isInteger(object.pid) || (object.pid as number) <= 0) return null;
  if (typeof object.startedAtMs !== 'number' || !Number.isFinite(object.startedAtMs)) return null;
  if (typeof object.beatAtMs !== 'number' || !Number.isFinite(object.beatAtMs)) return null;
  if (object.label !== undefined && typeof object.label !== 'string') return null;

  const info: LockInfo = {
    pid: object.pid as number,
    startedAtMs: object.startedAtMs,
    beatAtMs: object.beatAtMs,
  };
  if (typeof object.label === 'string') info.label = object.label;
  return { info, stored: value as StoredLock };
}

function readForAcquire(path: string): LockRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { kind: 'missing' };
    // An unreadable existing lock is not proof of staleness. Fail closed.
    throw new Error(`cannot read lock ${path}: ${(err as Error).message}`);
  }
  const parsed = parseStored(text);
  // A killed process can leave a truncated rewrite. Corrupt contents are
  // deliberately stale so that such a lock cannot block the gate forever.
  if (parsed === null) return { kind: 'corrupt' };
  return { kind: 'valid', ...parsed };
}

/** Read valid public holder information, or null for missing/corrupt contents. */
export function readLock(path: string): LockInfo | null {
  try {
    const parsed = parseStored(readFileSync(path, 'utf8'));
    return parsed?.info ?? null;
  } catch {
    return null;
  }
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return errorCode(err) === 'ESRCH';
  }
}

function staleReason(
  read: Exclude<LockRead, { kind: 'missing' }>,
  atMs: number,
  staleMs: number,
): TakeoverInfo['reason'] | null {
  if (read.kind === 'corrupt') return 'corrupt';
  if (atMs - read.info.beatAtMs > staleMs) return 'stale-heartbeat';
  if (pidIsGone(read.info.pid)) return 'dead-pid';
  return null;
}

function identity(fd: number): FileIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function currentIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw err;
  }
}

function writeStored(fd: number, value: StoredLock): void {
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset, offset);
    if (written === 0) throw new Error('lock write made no progress');
    offset += written;
  }
  ftruncateSync(fd, data.length);
  fsyncSync(fd);
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertOption(name: string, value: number, allowZero: boolean): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} finite number`);
  }
}

/**
 * Acquire a lock using atomic exclusive file creation. A blocked result is
 * explicit: callers never proceed unless they receive a LockHandle.
 */
export function acquireLock(
  path: string,
  opts: AcquireOptions,
): LockHandle | { blocked: true; holder: LockInfo | null } {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  assertOption('waitMs', opts.waitMs, true);
  assertOption('staleMs', staleMs, true);
  assertOption('pollMs', pollMs, false);

  const clock = opts.now ?? Date.now;
  const usesRealClock = opts.now === undefined;
  const waitingStartedAt = clock();
  let atMs = waitingStartedAt;
  let takeover: TakeoverInfo | undefined;

  for (;;) {
    const token = ownerToken();
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw new Error(`cannot acquire lock ${path}: ${(err as Error).message}`);
      }

      const holderRead = readForAcquire(path);
      if (holderRead.kind === 'missing') {
        atMs = clock();
        continue;
      }
      const reason = staleReason(holderRead, atMs, staleMs);
      if (reason !== null) {
        // Confirm immediately before removal: the owner may have completed an
        // in-progress heartbeat between our first read and this decision.
        const confirmed = readForAcquire(path);
        if (confirmed.kind === 'missing') {
          takeover = undefined;
          atMs = clock();
          continue;
        }
        const confirmedReason = staleReason(confirmed, atMs, staleMs);
        if (confirmedReason === null) {
          takeover = undefined;
          atMs = clock();
          continue;
        }
        let removed = false;
        try {
          unlinkSync(path);
          removed = true;
        } catch (unlinkErr) {
          if (errorCode(unlinkErr) !== 'ENOENT') {
            throw new Error(`cannot reclaim stale lock ${path}: ${(unlinkErr as Error).message}`);
          }
        }
        if (removed) {
          takeover = {
            atMs,
            reason: confirmedReason,
            holder: confirmed.kind === 'valid' ? confirmed.info : null,
          };
        } else {
          takeover = undefined;
        }
        atMs = clock();
        continue;
      }

      takeover = undefined;
      if (atMs - waitingStartedAt >= opts.waitMs) {
        return {
          blocked: true,
          holder: holderRead.kind === 'valid' ? holderRead.info : readLock(path),
        };
      }
      if (usesRealClock) {
        sleepSync(Math.min(pollMs, opts.waitMs - (atMs - waitingStartedAt)));
      }
      atMs = clock();
      continue;
    }

    const stored: StoredLock = {
      pid: process.pid,
      startedAtMs: atMs,
      beatAtMs: atMs,
      ownerToken: token,
    };
    if (takeover !== undefined) stored.takeover = takeover;

    let acquiredIdentity: FileIdentity;
    try {
      writeStored(fd, stored);
      acquiredIdentity = identity(fd);
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        /* best effort; a partial file is deliberately reclaimable as corrupt */
      }
      throw new Error(`cannot initialize lock ${path}: ${(err as Error).message}`);
    }
    closeSync(fd);
    const installedIdentity = currentIdentity(path);
    if (installedIdentity === null || !sameIdentity(installedIdentity, acquiredIdentity)) {
      takeover = undefined;
      atMs = clock();
      continue;
    }

    let released = false;
    return {
      path,
      heartbeat(): void {
        if (released) return;
        let heartbeatFd: number;
        try {
          heartbeatFd = openSync(path, 'r+');
        } catch (err) {
          throw new Error(`cannot heartbeat lock ${path}: ${(err as Error).message}`);
        }
        try {
          if (!sameIdentity(identity(heartbeatFd), acquiredIdentity)) {
            throw new Error(`cannot heartbeat lock ${path}: ownership was lost`);
          }
          const parsed = parseStored(readFileSync(heartbeatFd, 'utf8'));
          if (parsed === null || parsed.stored.ownerToken !== token) {
            throw new Error(`cannot heartbeat lock ${path}: ownership was lost`);
          }
          parsed.stored.beatAtMs = clock();
          writeStored(heartbeatFd, parsed.stored);
        } finally {
          closeSync(heartbeatFd);
        }
      },
      release(): void {
        if (released) return;
        // The owner token written into the file is the authority here, not the inode.
        // Linux reuses inode numbers aggressively, so a replacement lock created after a
        // takeover can land on the same dev/ino as ours -- on which a stale handle would
        // cheerfully delete a lock it no longer owns, letting two verifications share one
        // build directory. (Caught by CI on Linux; it never reproduced on APFS.)
        let contents: string;
        try {
          contents = readFileSync(path, 'utf8');
        } catch (err) {
          if (errorCode(err) === 'ENOENT') {
            released = true;
            return;
          }
          throw new Error(`cannot release lock ${path}: ${(err as Error).message}`);
        }
        const parsed = parseStored(contents);
        if (parsed === null || parsed.stored.ownerToken !== token) {
          released = true; // someone else owns this file now: leave it alone
          return;
        }
        try {
          unlinkSync(path);
          released = true;
        } catch (err) {
          if (errorCode(err) === 'ENOENT') released = true;
          else throw new Error(`cannot release lock ${path}: ${(err as Error).message}`);
        }
      },
    };
  }
}
