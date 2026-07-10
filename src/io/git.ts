// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import type { DiffEntry, DiffStatus } from '../domain/types.ts';

// Typed git wrappers. Every call is execFileSync with an argv array (shell:false)
// so nothing is interpreted by a shell. All path-bearing output is read with -z
// (NUL-terminated), never the human/quoted format - this is the only safe way to
// handle paths with spaces, tabs, or unicode.

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

/** git-tracked files under cwd, capped to `cap` (reports truncation, never silently). */
export function listTrackedFiles(cwd: string, cap = 2000): { files: string[]; truncated: boolean } {
  const all = git(cwd, ['ls-files']).split('\n').filter((l) => l !== '');
  return { files: all.slice(0, cap), truncated: all.length > cap };
}

/** Read a file's content at a specific commit, or null if it doesn't exist there. */
export function showFileAtRev(cwd: string, sha: string, relPath: string): string | null {
  const r = tryGit(cwd, ['show', '--textconv', `${sha}:${relPath}`]);
  return r.ok ? r.stdout : null;
}

function splitNul(s: string): string[] {
  const parts = s.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// name-status -z: STATUS \0 path \0   (rename/copy: R### \0 old \0 new \0)
function parseNameStatus(out: string): Map<string, { status: DiffStatus; oldPath?: string }> {
  const toks = splitNul(out);
  const map = new Map<string, { status: DiffStatus; oldPath?: string }>();
  let i = 0;
  while (i < toks.length) {
    const raw = toks[i++]!;
    const letter = raw[0] as DiffStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = toks[i++]!;
      const newPath = toks[i++]!;
      map.set(newPath, { status: letter, oldPath });
    } else {
      const path = toks[i++]!;
      map.set(path, { status: letter });
    }
  }
  return map;
}

// numstat -z: added \t deleted \t path \0   (rename: added \t deleted \t \0 old \0 new \0)
function parseNumstat(out: string): Map<string, { added: number; deleted: number; binary: boolean; oldPath?: string }> {
  const toks = splitNul(out);
  const map = new Map<string, { added: number; deleted: number; binary: boolean; oldPath?: string }>();
  let i = 0;
  while (i < toks.length) {
    const head = toks[i++]!;
    // Format: `<added>\t<deleted>\t<path>`. A path may itself contain TABs (git -z
    // does NOT quote paths), so everything after the second TAB is the path -
    // do NOT lose it to destructuring. An empty path signals a rename entry.
    const parts = head.split('\t');
    const addedStr = parts[0] ?? '';
    const deletedStr = parts[1] ?? '';
    const rest = parts.slice(2).join('\t');
    const binary = addedStr === '-' || deletedStr === '-';
    const added = binary ? 0 : Number(addedStr);
    const deleted = binary ? 0 : Number(deletedStr);
    if (rest !== '') {
      map.set(rest, { added, deleted, binary });
    } else {
      // rename/copy: the two following tokens are old, new paths
      const oldPath = toks[i++]!;
      const newPath = toks[i++]!;
      map.set(newPath, { added, deleted, binary, oldPath });
    }
  }
  return map;
}

/**
 * Full structured diff base..head (head defaults to the working tree). Renames
 * and copies are detected; both old and new paths are reported.
 */
export function collectDiff(cwd: string, base: string, head?: string): DiffEntry[] {
  const range = head !== undefined ? [base, head] : [base];
  const nameStatus = parseNameStatus(
    git(cwd, ['diff', '--name-status', '-z', '--find-renames', '--find-copies', ...range]),
  );
  const numstat = parseNumstat(
    git(cwd, ['diff', '--numstat', '-z', '--find-renames', '--find-copies', ...range]),
  );

  const entries: DiffEntry[] = [];
  for (const [path, ns] of nameStatus) {
    const num = numstat.get(path);
    entries.push({
      status: ns.status,
      path,
      ...(ns.oldPath !== undefined ? { oldPath: ns.oldPath } : {}),
      added: num?.added ?? 0,
      deleted: num?.deleted ?? 0,
      binary: num?.binary ?? false,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/** Raw unified patch text for base..head (head defaults to the working tree). */
export function rawDiff(cwd: string, base: string, head?: string): string {
  const range = head !== undefined ? [base, head] : [base];
  return git(cwd, ['diff', '--binary', ...range]);
}

/** True if `patch` applies cleanly in `cwd` (`git apply --check`). */
export function applyCheck(cwd: string, patch: string): boolean {
  if (patch.trim() === '') return true;
  return tryGit(cwd, ['apply', '--check', '-'], patch).ok;
}

export function worktreeAdd(cwd: string, path: string, branch: string, base: string): void {
  git(cwd, ['worktree', 'add', '-b', branch, '--', path, base]);
}

/** Add a throwaway worktree checked out at `sha` with a detached HEAD (no branch). */
export function worktreeAddDetached(cwd: string, path: string, sha: string): void {
  git(cwd, ['worktree', 'add', '--detach', '--', path, sha]);
}

export function worktreeRemove(cwd: string, path: string, force = true): void {
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path];
  const r = tryGit(cwd, args);
  if (!r.ok) tryGit(cwd, ['worktree', 'prune']); // best effort
}


/** Stage everything and commit; returns false (no commit) if the tree is clean. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A']);
  if (git(cwd, ['diff', '--cached', '--name-only']).trim() === '') return false;
  git(cwd, ['commit', '-q', '-m', message]);
  return true;
}

/** Hard-reset a worktree to `sha` and remove untracked files - used to give the
 * next executor in a fallback chain a clean checkout after one quota-failed. */
export function resetHard(cwd: string, sha: string): void {
  git(cwd, ['reset', '--hard', sha]);
  git(cwd, ['clean', '-fd']);
}

/** Merge a branch into the current HEAD (no fast-forward). Throws on conflict. */
export function mergeNoFF(cwd: string, branch: string): void {
  git(cwd, ['merge', '--no-ff', '--no-edit', branch]);
}

/** Abort an in-progress merge, restoring the working tree. Best effort. */
export function mergeAbort(cwd: string): void {
  tryGit(cwd, ['merge', '--abort']);
}

export function branchExists(cwd: string, branch: string): boolean {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export function deleteBranch(cwd: string, branch: string): void {
  tryGit(cwd, ['branch', '-D', branch]);
}
