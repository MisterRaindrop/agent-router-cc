// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { killProcessGroup, processGroupIsGone } from './signals.ts';
import {
  closeSync,
  fstatSync,
  linkSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
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

export const DEFAULT_STALE_MS = 90_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_REAP_GRACE_MS = 3_000;
/**
 * How long a reclaimer's lease may go UNRENEWED before another process may break it.
 *
 * Renewed on every poll of the reap loop, so a live reclaimer -- however slow its reap -- never
 * expires. It was a fixed wall-clock deadline from the moment the mutex was taken, which meant a
 * reclaimer doing an honest long reap (a large `reapGraceMs`, a paused process) was overtaken
 * while it worked. The bound exists only so a reclaimer KILLED mid-reclaim cannot wedge the
 * checkout forever, and that is the only thing it should be able to do.
 */
const RECLAIM_LEASE_MS = 30_000;
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
function reapExecutorGroup(
  pgid: number,
  graceMs: number,
  onPoll: () => void = () => {},
): TakeoverInfo['reaped'] | undefined {
  if (processGroupIsGone(pgid)) return undefined;
  killProcessGroup(pgid, 'SIGTERM');
  const termDeadline = Date.now() + graceMs;
  while (Date.now() < termDeadline) {
    if (processGroupIsGone(pgid)) return { pgid, signal: 'SIGTERM' };
    sleepSync(50);
    onPoll(); // renew the reclaimer lease: this loop is the slow part, not a dead process
  }
  killProcessGroup(pgid, 'SIGKILL');
  const killDeadline = Date.now() + graceMs;
  while (Date.now() < killDeadline) {
    if (processGroupIsGone(pgid)) return { pgid, signal: 'SIGKILL' };
    sleepSync(50);
    onPoll();
  }
  throw new Error(
    `cannot reclaim lock: the previous holder's executor group ${pgid} survived SIGKILL. ` +
      `Proceeding would put two executors in one checkout; kill it manually and retry.`,
  );
}

/** The lock file's exact bytes together with the identity of the inode they came from. */
interface LockSnapshot {
  text: string;
  identity: FileIdentity;
  mtimeMs: number;
}

/**
 * Read the bytes and the inode identity through ONE descriptor.
 *
 * Two separate calls would be two different files under a rename, which is the whole thing this
 * type exists to make impossible: every later comparison against a snapshot is a claim about one
 * specific file, not about whatever currently answers to that path.
 */
function readSnapshot(path: string): LockSnapshot | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    throw new Error(`cannot read lock ${path}: ${(err as Error).message}`);
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    return {
      text: readFileSync(fd, 'utf8'),
      identity: { dev: stat.dev, ino: stat.ino },
      mtimeMs: Number(stat.mtimeNs / 1_000_000n),
    };
  } finally {
    closeSync(fd);
  }
}

/** Interpret a snapshot the way readForAcquire interprets a path. */
function snapshotRead(snapshot: LockSnapshot): Exclude<LockRead, { kind: 'missing' }> {
  const parsed = parseStored(snapshot.text);
  return parsed === null ? { kind: 'corrupt' } : { kind: 'valid', ...parsed };
}

/** Whether `path` currently holds exactly the file `snapshot` was taken from. */
function stillTheSameFile(path: string, snapshot: LockSnapshot): boolean {
  const now = readSnapshot(path);
  return (
    now !== null && now.text === snapshot.text && sameIdentity(now.identity, snapshot.identity)
  );
}

type ReclaimOutcome =
  | { kind: 'removed'; takeover: TakeoverInfo }
  /** Nothing to do here any more; look at the path again. */
  | { kind: 'retry' }
  /** Another reclaimer is inside, and it is alive. Waiting on it is the caller's decision. */
  | { kind: 'busy' }
  /** A reclaimer that died mid-reclaim was cleared away; the reclaim itself has yet to happen. */
  | { kind: 'recovered' };

/**
 * Remove a reclaimer mutex whose owner is demonstrably not coming back.
 *
 * Recoverability is the point: without this, a reclaimer killed between creating the mutex and
 * releasing it would make the checkout permanently unacquirable by anyone.
 */
function clearDeadReclaimer(mutexPath: string): boolean {
  const snapshot = readSnapshot(mutexPath);
  if (snapshot === null) return true; // already gone: whatever held it is not holding it now
  const held = parseReclaimer(snapshot.text);
  const dead =
    held === null
      ? // Unparseable. With link-install there is no window in which a LIVE holder's mutex is
        // empty, but a process killed mid-renewal can still leave a truncated one, so this stays
        // reachable -- behind a grace period, because reading "not valid JSON yet" as "its owner
        // is dead" is precisely how the previous version let a second reclaimer in.
        Date.now() - snapshot.mtimeMs > RECLAIM_LEASE_MS
      : pidIsGone(held.pid) || Date.now() - held.beatAtMs > RECLAIM_LEASE_MS;
  // Re-confirm the bytes right before removing them: a live reclaimer may have renewed or
  // replaced this file since the read above, and deleting THAT one would put two reclaimers back
  // in the race.
  if (!dead || !stillTheSameFile(mutexPath, snapshot)) return false;
  try {
    unlinkSync(mutexPath);
  } catch {
    /* someone else cleared it first, which is the outcome we wanted anyway */
  }
  return true;
}

interface ReclaimerRecord {
  pid: number;
  beatAtMs: number;
  token: string;
}

function parseReclaimer(text: string): ReclaimerRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return null;
    if (typeof value.beatAtMs !== 'number' || !Number.isFinite(value.beatAtMs)) return null;
    if (typeof value.token !== 'string' || value.token === '') return null;
    return { pid: value.pid as number, beatAtMs: value.beatAtMs, token: value.token };
  } catch {
    return null;
  }
}

function reclaimerText(token: string): string {
  return `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token })}\n`;
}

/**
 * Install the reclaimer mutex atomically, or return false because somebody else holds it.
 *
 * Write-then-link rather than `open(path, 'wx')`-then-write. The exclusive create is atomic, but
 * the file it creates is EMPTY until the next syscall, and a competitor reading it in that window
 * found unparseable contents and removed it as a dead reclaimer -- while its owner was very much
 * alive and about to reap. `link(2)` publishes a file that is already complete, so the window
 * does not exist. Measured before this change: `{"creatorFdStillValid":true,"contenderAcquired":true}`.
 */
function installReclaimer(mutexPath: string, token: string): boolean {
  const staging = `${mutexPath}.${process.pid}.${ownerCounter}.tmp`;
  try {
    writeFileSync(staging, reclaimerText(token), { flag: 'w' });
    const fd = openSync(staging, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(staging, mutexPath);
    return true;
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return false;
    throw new Error(`cannot install reclaimer for ${mutexPath}: ${(err as Error).message}`);
  } finally {
    try {
      unlinkSync(staging);
    } catch {
      /* the link (if any) keeps the inode alive; the staging name is disposable */
    }
  }
}

/** Whether `mutexPath` still names OUR reclaim, by token rather than by mere existence. */
function stillReclaiming(mutexPath: string, token: string): boolean {
  const snapshot = readSnapshot(mutexPath);
  return snapshot !== null && parseReclaimer(snapshot.text)?.token === token;
}

/** Push the lease out, so an honest long reap is never overtaken. Silent if we no longer hold it. */
function renewReclaimer(mutexPath: string, token: string): void {
  if (!stillReclaiming(mutexPath, token)) return;
  try {
    writeFileSync(mutexPath, reclaimerText(token));
  } catch {
    /* a failed renewal only risks being overtaken, which the checks below still catch */
  }
}

/** Release only what is still ours. A lease-breaker may have replaced it while we worked. */
function releaseReclaimer(mutexPath: string, token: string): void {
  if (!stillReclaiming(mutexPath, token)) return;
  try {
    unlinkSync(mutexPath);
  } catch {
    /* gone already */
  }
}

/**
 * Reclaim one confirmed-stale lock, with reap and unlink serialised behind a mutex of their own.
 *
 * Why a second lock file to take the first one: reaping is SLOW -- up to two full grace periods
 * while a SIGTERM is waited out and escalated -- and every step of the reclaim used to run
 * concurrently in every process that had spotted the same stale lock. Two of them would reap the
 * same (already dying) group, which is harmless, and then both unlink: the second `unlinkSync`
 * deletes the BRAND NEW lock the first one had already installed, and both walk away holding a
 * LockHandle for the same checkout. Measured by the reviewer: `bothAcquired: true`.
 *
 * Serialising fixes it at the root -- only the mutex holder may reap, unlink, or judge the file
 * stale -- and the exclusive-create the caller does afterwards still decides who actually gets
 * the lock, so nothing here needs to be trusted for correctness beyond "at most one reclaimer".
 */
function reclaimStaleLock(
  path: string,
  expected: LockSnapshot,
  atMs: number,
  staleMs: number,
  reapGraceMs: number,
): ReclaimOutcome {
  const mutexPath = `${path}.reclaim`;
  const token = ownerToken();
  if (!installReclaimer(mutexPath, token)) {
    // Someone else is reclaiming. If they are alive, that is their turn and not ours; if they
    // died holding the mutex, clearing it is the only thing standing between this checkout and
    // being unacquirable forever, and the caller must come straight back rather than treat the
    // recovery as a failed attempt.
    return clearDeadReclaimer(mutexPath) ? { kind: 'recovered' } : { kind: 'busy' };
  }
  try {
    // Everything below re-derives its facts under the mutex. What the caller saw outside it is
    // only a reason to look, never a licence to delete.
    const held = readSnapshot(path);
    if (held === null) return { kind: 'retry' }; // already reclaimed by whoever went before us
    if (held.text !== expected.text || !sameIdentity(held.identity, expected.identity)) {
      return { kind: 'retry' }; // a different lock lives here now, and it is not ours to judge
    }
    const read = snapshotRead(held);
    const reason = staleReason(read, atMs, staleMs);
    if (reason === null) return { kind: 'retry' }; // it beat while we were getting the mutex

    const holder = read.kind === 'valid' ? read.info : null;
    const reaped =
      holder?.execPgid !== undefined
        ? reapExecutorGroup(holder.execPgid, reapGraceMs, () => renewReclaimer(mutexPath, token))
        : undefined;

    // The reap above can take seconds. Two things have to be true before the unlink, and each
    // covers what the other cannot: that the lock file is still the one we judged (a live holder
    // could have released it and a fresh acquirer taken its place), and that this reclaim is
    // still OURS (a lease-breaker could have decided we were dead and let someone else in).
    if (!stillReclaiming(mutexPath, token)) return { kind: 'retry' };
    if (!stillTheSameFile(path, held)) return { kind: 'retry' };
    try {
      unlinkSync(path);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        throw new Error(`cannot reclaim stale lock ${path}: ${(err as Error).message}`);
      }
      return { kind: 'retry' };
    }
    return {
      kind: 'removed',
      takeover: { atMs, reason, holder, ...(reaped !== undefined ? { reaped } : {}) },
    };
  } finally {
    releaseReclaimer(mutexPath, token);
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
  const reapGraceMs = opts.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
  assertOption('waitMs', opts.waitMs, true);
  assertOption('staleMs', staleMs, true);
  assertOption('pollMs', pollMs, false);

  const clock = opts.now ?? Date.now;
  const usesRealClock = opts.now === undefined;
  const waitingStartedAt = clock();
  let atMs = waitingStartedAt;
  let takeover: TakeoverInfo | undefined;
  // Breaking a dead reclaimer's lease earns one free retry, not an unlimited supply: a caller
  // that asked not to wait still must not spin here if something keeps re-creating the mutex.
  let recoveries = 0;

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
        const confirmed = readSnapshot(path);
        if (confirmed === null) {
          takeover = undefined;
          atMs = clock();
          continue;
        }
        if (staleReason(snapshotRead(confirmed), atMs, staleMs) === null) {
          takeover = undefined;
          atMs = clock();
          continue;
        }
        // REAP FIRST, THEN UNLINK, and BOTH behind the reclaimer mutex. The order matters
        // because reaping can wait out a SIGTERM grace and escalate to SIGKILL: with the old
        // unlink-then-reap the lock path did not exist for that whole span, so a third process
        // could `openSync(path, 'wx')` straight through the hole while the orphan it was being
        // protected from was still running. The mutex matters because leaving the file in place
        // is not enough on its own -- a second process re-reads it, agrees it is stale, and ends
        // up deleting the replacement lock the first one has meanwhile installed.
        const outcome = reclaimStaleLock(path, confirmed, atMs, staleMs, reapGraceMs);
        takeover = outcome.kind === 'removed' ? outcome.takeover : undefined;
        if (outcome.kind === 'recovered' && recoveries === 0) {
          recoveries += 1;
          atMs = clock();
          continue;
        }
        if (outcome.kind === 'busy' || outcome.kind === 'recovered') {
          // Another process is inside the reclaim. Waiting for it is exactly what `waitMs` is
          // for, and counting it is what stops this from becoming an unbounded spin: a caller
          // that asked not to wait must be told the checkout is taken, not loop until it is.
          if (atMs - waitingStartedAt >= opts.waitMs) {
            return { blocked: true, holder: readLock(path) };
          }
          if (usesRealClock) {
            sleepSync(Math.min(pollMs, opts.waitMs - (atMs - waitingStartedAt)));
          }
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
