// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ExitClass, ModelSpec, WriteRecord } from '../domain/types.ts';
import { detectContractConflict, detectModelMismatch, reclassifyEnvironmentFailure } from '../core/exitTaxonomy.ts';
import { writeJsonAtomic } from '../io/atomicWrite.ts';
import { buildExecutorEnv } from '../io/env.ts';
import { commitsSince, currentBranch, resolveCommit, uncommittedSourceFiles } from '../io/git.ts';
import { branchRefPath, type RouterPaths } from '../io/paths.ts';
import { superviseWorker, type SupervisionOutcome } from '../io/supervisor.ts';
import { codexResumeArgv, codexWriteArgv, parseCodexLog } from './codex.ts';

// An external codex writer, launched only when the user names a model. The main session writes
// the code by default; this exists because "let a different model write this part" turned out
// to be worth keeping when everything else about delegating to an executor was removed.
//
// What it deliberately does NOT do, because the dispatch machinery that did it is gone: no lock
// (the writer is the only process touching the checkout while the main session waits on it), no
// branch of its own (it commits where you are), no rescue of uncommitted work (it refuses
// instead), no gates (the main session reads the diff and runs the real build itself).

export const WRITE_MAX_WALL_MINUTES = 120;
export const WRITE_STALL_MINUTES = 20;

export interface WriteOptions {
  id: string;
  /** The brief the writer works from: what to build, where, how it will be checked. */
  brief: string;
  model: ModelSpec;
  maxWallMinutes?: number;
  stallMinutes?: number;
}

export class WriteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteRefusal';
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function readWriteRecord(paths: RouterPaths, id: string): WriteRecord | null {
  try {
    return JSON.parse(readFileSync(paths.writeRecord(id), 'utf8')) as WriteRecord;
  } catch {
    return null;
  }
}

// A writer is launched into a clean tree, or not at all. The old dispatch flow committed the
// user's uncommitted work for them first; that needed a whole rescue protocol to stay safe, and
// the simpler rule loses nothing: the main session commits (or the user does) and runs again.
// `uncommittedSourceFiles` throws when git cannot answer, and that is a refusal too -- "could
// not check" must never read as "clean".
function requireCleanTree(repoRoot: string): void {
  const dirty = uncommittedSourceFiles(repoRoot);
  if (dirty.length > 0) {
    throw new WriteRefusal(
      `working tree has ${dirty.length} uncommitted change(s); commit or stash them first:\n  ` +
        dirty.slice(0, 10).join('\n  '),
    );
  }
}

function uncommittedOrUnknown(repoRoot: string): string[] {
  try {
    return uncommittedSourceFiles(repoRoot);
  } catch {
    return ['<git status failed: uncommitted state unknown>'];
  }
}

async function run(
  paths: RouterPaths,
  id: string,
  argv: string[],
  branch: string,
  maxWallMinutes: number,
  stallMinutes: number,
): Promise<{ outcome: SupervisionOutcome; log: string }> {
  const logPath = paths.writeLog(id);
  writeFileSync(logPath, '');
  const outcome = await superviseWorker({
    argv,
    cwd: paths.repoRoot,
    env: buildExecutorEnv(process.env),
    logPath,
    heartbeatPath: paths.writeHeartbeat(id),
    // A commit landing is the writer actually finishing something, so the branch ref counts as
    // liveness alongside log growth.
    watchPaths: [branchRefPath(paths.repoRoot, branch)],
    maxWallMs: maxWallMinutes * 60_000,
    stallMs: stallMinutes * 60_000,
  });
  return { outcome, log: readFileSync(logPath, 'utf8') };
}

function classify(outcome: SupervisionOutcome, log: string, finalMessage: string | undefined): ExitClass {
  if (detectContractConflict(finalMessage)) return 'contract_conflict';
  return reclassifyEnvironmentFailure(outcome.exitClass, log);
}

/** Launch codex on the current branch with a brief. Refuses on a dirty tree or a reused id. */
export async function writeWithCodex(paths: RouterPaths, opts: WriteOptions): Promise<WriteRecord> {
  if (!ID_RE.test(opts.id)) throw new WriteRefusal(`invalid write id "${opts.id}" (lowercase, digits, . _ -)`);
  if (existsSync(paths.writeRecord(opts.id))) {
    throw new WriteRefusal(`write ${opts.id} already exists; use \`router resume ${opts.id}\` or a new id`);
  }
  const repoRoot = paths.repoRoot;
  const branch = currentBranch(repoRoot);
  if (branch === null) throw new WriteRefusal('HEAD is detached; check out a branch for the writer to commit on');
  requireCleanTree(repoRoot);

  const baseSha = resolveCommit(repoRoot, 'HEAD');
  mkdirSync(paths.writeDir(opts.id), { recursive: true });
  writeFileSync(paths.writeBrief(opts.id), opts.brief);

  const startedAt = new Date().toISOString();
  const { outcome, log } = await run(
    paths,
    opts.id,
    codexWriteArgv(writerPrompt(opts.brief), repoRoot, opts.model),
    branch,
    opts.maxWallMinutes ?? WRITE_MAX_WALL_MINUTES,
    opts.stallMinutes ?? WRITE_STALL_MINUTES,
  );
  const parsed = parseCodexLog(log);
  const exitClass = classify(outcome, log, parsed.finalMessage);
  const record: WriteRecord = {
    id: opts.id,
    model: parsed.model ?? opts.model.model,
    ...(opts.model.effort !== undefined ? { effort: opts.model.effort } : {}),
    branch,
    base_sha: baseSha,
    session_id: parsed.sessionId,
    exit_class: exitClass,
    rc: outcome.rc,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    resumes: 0,
    commits: commitsSince(repoRoot, baseSha),
    uncommitted: uncommittedOrUnknown(repoRoot),
    ...(parsed.finalMessage !== undefined ? { final_message: parsed.finalMessage } : {}),
    ...(exitClass !== 'ok' && detectModelMismatch(log) ? { model_mismatch: true } : {}),
  };
  writeJsonAtomic(paths.writeRecord(opts.id), record);
  return record;
}

/**
 * Send feedback to the SAME codex session, so it keeps what it learned about the repository
 * instead of re-reading it. Refuses on a different branch (continuing there would run the writer
 * against the wrong tree) and on a dirty tree, exactly as a fresh write does.
 *
 * A resume that reports a different session id -- or none at all -- is not a continuation, and
 * is recorded as such rather than trusted. Measured: a resume invoked with a flag the CLI rejects
 * dies before starting and reports no id, and an earlier guard read that absence as agreement.
 */
export async function resumeWrite(paths: RouterPaths, id: string, feedback: string, model?: ModelSpec): Promise<WriteRecord> {
  const prev = readWriteRecord(paths, id);
  if (prev === null) throw new WriteRefusal(`no write named ${id}; start one with \`router write\``);
  if (prev.session_id === null) {
    throw new WriteRefusal(`write ${id} recorded no codex session id; resume unavailable -- start a new write`);
  }
  const repoRoot = paths.repoRoot;
  const branch = currentBranch(repoRoot);
  if (branch !== prev.branch) {
    throw new WriteRefusal(`write ${id} ran on ${prev.branch}, but HEAD is ${branch ?? 'detached'}; check it out first`);
  }
  requireCleanTree(repoRoot);

  const pin: ModelSpec = model ?? { model: prev.model, ...(prev.effort !== undefined ? { effort: prev.effort } : {}) };
  const { outcome, log } = await run(
    paths,
    id,
    codexResumeArgv(prev.session_id, feedback, pin),
    branch,
    WRITE_MAX_WALL_MINUTES,
    WRITE_STALL_MINUTES,
  );
  const parsed = parseCodexLog(log);
  const mismatch = parsed.sessionId !== prev.session_id;
  const exitClass: ExitClass = mismatch ? 'task_failed' : classify(outcome, log, parsed.finalMessage);
  const record: WriteRecord = {
    ...prev,
    exit_class: exitClass,
    rc: outcome.rc,
    ended_at: new Date().toISOString(),
    resumes: prev.resumes + 1,
    commits: commitsSince(repoRoot, prev.base_sha),
    uncommitted: uncommittedOrUnknown(repoRoot),
    ...(parsed.finalMessage !== undefined ? { final_message: parsed.finalMessage } : {}),
    ...(mismatch ? { resume_session_mismatch: true } : {}),
  };
  if (!mismatch) delete record.resume_session_mismatch;
  writeJsonAtomic(paths.writeRecord(id), record);
  return record;
}

/**
 * The brief, wrapped in the few rules a writer always owes back. Kept short on purpose: the
 * writer is a strong model, and the brief the main session wrote is the contract.
 */
export function writerPrompt(brief: string): string {
  return (
    `${brief.trimEnd()}\n\n` +
    `---\n` +
    `How to deliver:\n` +
    `- Commit one functional unit at a time, each with a message that says why. Leave nothing uncommitted.\n` +
    `- Write the tests the work needs, and run them.\n` +
    `- Stay on the current branch. Do not merge, rebase, push, or rewrite history.\n` +
    `- If the code contradicts this brief in a way you cannot resolve, stop and begin your final message ` +
    `with CONTRACT_CONFLICT followed by the evidence.\n` +
    `- End with a short report: what you changed, what you ran and its result, and anything you are unsure of.\n`
  );
}
