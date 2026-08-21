// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { killProcessGroup } from './signals.ts';
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
  /**
   * Process-group id of the executor this holder launched, once it has one.
   *
   * Recorded in the lock rather than only in the run record because of who needs it: the
   * process that reclaims a dead holder's lock. That process has the lock file and nothing
   * else, and it must not enter the checkout while the dead holder's executor is still
   * writing to it.
   */
  execPgid?: number;
}

export interface LockHandle {
  path: string;
  /**
   * What this acquisition had to reclaim, or null for an uncontested lock. Non-null means a
   * previous holder died holding it; `reaped` names the orphan executor group that had to be
   * killed before we were allowed in. Callers report it -- silently inheriting a checkout
   * someone else's process was writing to is the failure this field exists to make visible.
   */
  takeover: TakeoverInfo | null;
  /**
   * The token that proves this handle still owns the file. Exposed so the out-of-process
   * heartbeat (io/heartbeat.ts) can apply the same ownership rule release() does: beat only
   * while the file still names us, never merely because the path exists.
   */
  ownerToken: string;
  release(): void;
  heartbeat(): void;
  /** Publish the executor process group we just launched, so a future reclaimer can reap it. */
  recordExecPgid(pgid: number): void;
}

export interface AcquireOptions {
  waitMs: number;
  staleMs?: number;
  pollMs?: number;
  now?: () => number;
  /** How long to wait for a reclaimed predecessor's executor group at each escalation step. */
  reapGraceMs?: number;
}

interface TakeoverInfo {
  atMs: number;
  reason: 'corrupt' | 'dead-pid' | 'stale-heartbeat';
  holder: LockInfo | null;
  /** The predecessor's executor group we had to kill first, and with what. */
  reaped?: { pgid: number; signal: 'SIGTERM' | 'SIGKILL' };
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
const DEFAULT_REAP_GRACE_MS = 3_000;
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
  // execPgid and ownerToken are deliberately NOT required: a lock written by an older build
  // has neither, and treating those as corrupt would declare every pre-upgrade lock stale at
  // the moment of upgrade -- i.e. hand the checkout to a second process while the first works.
  const info: LockInfo = {
    pid: object.pid as number,
    startedAtMs: object.startedAtMs,
    beatAtMs: object.beatAtMs,
  };
  if (typeof object.label === 'string') info.label = object.label;
  if (Number.isInteger(object.execPgid) && (object.execPgid as number) > 1) {
    info.execPgid = object.execPgid as number;
  }
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

/**
 * Whether `path` is still held under `token`.
 *
 * Needed by callers whose beat runs in another process: the beater exits when ownership is
 * lost, but it cannot tell its parent, so the parent has to ask. Fails closed -- a missing or
 * corrupt file is not ours.
 */
export function ownsLock(path: string, token: string): boolean {
  try {
    return parseStored(readFileSync(path, 'utf8'))?.stored.ownerToken === token;
  } catch {
    return false;
  }
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

function groupIsGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    const code = errorCode(err);
    // ESRCH: nothing left in the group. EPERM: it exists but is not ours to signal, which we
    // must NOT read as gone -- that would be exactly the "two writers, one checkout" case.
    //
    // One nuance, in case this ever looks like a bug: a SIGKILLed process still answers
    // signal 0 while it is a zombie, i.e. until its parent reaps it. That cannot happen to the
    // process this function is aimed at -- the executor's parent is the router that died, so it
    // has already been reparented to init, which reaps immediately. A caller that is itself the
    // orphan's parent would have to reap it, and this loop (which blocks the event loop) would
    // never let Node do so.
    return code === 'ESRCH';
  }
}

/**
 * Kill a dead holder's executor group and do not return until it is actually gone.
 *
 * This is the reason a reclaim is not just "unlink the file". The old worktree model made the
 * hazard harmless: an orphaned executor kept scribbling in an isolated directory nobody wanted.
 * Under the branch model that orphan is writing the user's own checkout, and the lock it was
 * covered by has just been declared stale -- so without this, the reclaiming dispatch launches
 * a second executor into a working tree the first one is still editing.
 *
 * Fails closed. If the group survives SIGKILL we throw rather than proceed, because there is no
 * safe way to share the checkout with a process we cannot stop.
 */
function reapExecutorGroup(pgid: number, graceMs: number): TakeoverInfo['reaped'] | undefined {
  if (groupIsGone(pgid)) return undefined;
  killProcessGroup(pgid, 'SIGTERM');
  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline) {
    if (groupIsGone(pgid)) return { pgid, signal: 'SIGTERM' };
    sleepSync(50);
  }
  killProcessGroup(pgid, 'SIGKILL');
  const killDeadline = Date.now() + graceMs;
  while (Date.now() < killDeadline) {
    if (groupIsGone(pgid)) return { pgid, signal: 'SIGKILL' };
    sleepSync(50);
  }
  throw new Error(
    `cannot reclaim lock: the previous holder's executor group ${pgid} survived SIGKILL. ` +
      `Proceeding would put two executors in one checkout; kill it manually and retry.`,
  );
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
  const reapGraceMs = opts.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
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
          const holder = confirmed.kind === 'valid' ? confirmed.info : null;
          // Order matters: the orphan dies before we hand the checkout to anyone else. Doing
          // this after acquisition would leave a window in which both executors are live.
          const reaped =
            holder?.execPgid !== undefined
              ? reapExecutorGroup(holder.execPgid, reapGraceMs)
              : undefined;
          takeover = {
            atMs,
            reason: confirmedReason,
            holder,
            ...(reaped !== undefined ? { reaped } : {}),
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
    const acquiredTakeover = takeover ?? null;
    return {
      path,
      ownerToken: token,
      takeover: acquiredTakeover,
      recordExecPgid(pgid: number): void {
        if (released) return;
        const fd = openSync(path, 'r+');
        try {
          if (!sameIdentity(identity(fd), acquiredIdentity)) {
            throw new Error(`cannot record exec pgid on ${path}: ownership was lost`);
          }
          const parsed = parseStored(readFileSync(fd, 'utf8'));
          if (parsed === null || parsed.stored.ownerToken !== token) {
            throw new Error(`cannot record exec pgid on ${path}: ownership was lost`);
          }
          parsed.stored.execPgid = pgid;
          writeStored(fd, parsed.stored);
        } finally {
          closeSync(fd);
        }
      },
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
