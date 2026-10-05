// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

// Typed git wrappers. Every call is execFileSync with an argv array (shell:false) so nothing is
// interpreted by a shell. Only what `router write` needs survives: the diff, scope, worktree and
// branch-management helpers went with dispatch in 0.15.0.

export class GitError extends Error {
  readonly stderr: string;
  readonly code: number | null;
  constructor(args: string[], stderr: string, code: number | null) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.stderr = stderr;
    this.code = code;
  }
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function tryGit(cwd: string, args: string[], input?: string): RunResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      code: e.status ?? null,
    };
  }
}

function git(cwd: string, args: string[], input?: string): string {
  const r = tryGit(cwd, args, input);
  if (!r.ok) throw new GitError(args, r.stderr, r.code);
  return r.stdout;
}

/** Resolve a ref to a full 40-hex commit SHA. Throws if it isn't a commit. */
export function resolveCommit(cwd: string, ref: string): string {
  return git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}

/** The checked-out branch, or null when HEAD is detached (a Git detached head, not a detached process). */
export function currentBranch(cwd: string): string | null {
  const r = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

function pathspec(exclude: readonly string[]): string[] {
  if (exclude.length === 0) return [];
  return ['--', '.', ...exclude.map((path) => `:(exclude,glob)${path}`), ...exclude.map((path) => `:(exclude,glob)${path}/**`)];
}

/**
 * Uncommitted work that the closing invariant forbids: tracked edits and non-ignored
 * untracked files, excluding submodule content dirt. Returned as porcelain lines so the
 * caller can name the files in its failure message.
 *
 * This is the check that replaces the old catch-all `commitAll`. Dropping that catch-all
 * without adding this would let an executor forget its last file: the file never enters
 * `base_sha..HEAD`, so every gate passes without ever seeing it, and the run reports success
 * while unreviewed code sits in the user's checkout.
 */
export function uncommittedSourceFiles(cwd: string, exclude: readonly string[] = []): string[] {
  const args = ['status', '--porcelain', '--ignore-submodules=dirty', ...pathspec(exclude)];
  const r = tryGit(cwd, args);
  // THROWS on failure; it used to return [] "best effort". That turned "I could not check" into
  // "the tree is clean" -- for the one function that decides both whether to rescue the user's
  // work and whether the closing invariant holds. A corrupt index makes `git status` exit
  // non-zero with a fatal message, and the old code answered "clean": the rescue would be
  // skipped and the closeout would report {ok:true} over a working tree nobody had seen.
  //
  // Callers that only REPORT (rather than decide) must catch this and say "unknown" -- never
  // "none". See uncommittedSourceFilesOrUnknown.
  if (!r.ok) throw new GitError(args, r.stderr, r.code);
  return r.stdout.split('\n').filter((line) => line !== '');
}

/** `git log --oneline base..HEAD`: the commits made since `base`, newest first. */
export function commitsSince(cwd: string, base: string): string[] {
  return git(cwd, ['log', '--oneline', '--no-decorate', `${base}..HEAD`])
    .split('\n')
    .filter((line) => line !== '');
}
