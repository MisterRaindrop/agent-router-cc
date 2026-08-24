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

/** Current branch name, or the detached HEAD commit when no branch is checked out. */
export function currentRef(cwd: string): string {
  const branch = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return branch.ok ? branch.stdout.trim() : resolveCommit(cwd, 'HEAD');
}

/** Check out an existing branch/ref. A commit SHA naturally restores detached HEAD. */
export function checkoutRef(cwd: string, ref: string): void {
  git(cwd, ['checkout', '--quiet', ref]);
}

/** Create `branch` at the current HEAD when absent, then check it out. */
export function checkoutBranch(cwd: string, branch: string): void {
  if (branchExists(cwd, branch)) {
    checkoutRef(cwd, branch);
    return;
  }
  git(cwd, ['checkout', '--quiet', '-b', branch, 'HEAD']);
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

// raw -z: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>" \0 path \0
// (rename/copy: ... R### \0 old \0 new \0). Only the destination mode is kept: the
// exec-bit gate needs to know how the executor actually created/left the file.
function parseRawModes(out: string): Map<string, string> {
  const toks = splitNul(out);
  const map = new Map<string, string>();
  let i = 0;
  while (i < toks.length) {
    const meta = toks[i++]!;
    if (!meta.startsWith(':')) continue; // defensive: ignore anything unexpected
    const fields = meta.slice(1).split(' ');
    const dstMode = fields[1] ?? '';
    const status = fields[4] ?? '';
    const path = status.startsWith('R') || status.startsWith('C') ? (i++, toks[i++]) : toks[i++];
    if (path !== undefined && dstMode !== '') map.set(path, dstMode);
  }
  return map;
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
  const modes = parseRawModes(
    git(cwd, ['diff', '--raw', '-z', '--find-renames', '--find-copies', ...range]),
  );

  const entries: DiffEntry[] = [];
  for (const [path, ns] of nameStatus) {
    const num = numstat.get(path);
    const mode = modes.get(path);
    entries.push({
      status: ns.status,
      path,
      ...(ns.oldPath !== undefined ? { oldPath: ns.oldPath } : {}),
      added: num?.added ?? 0,
      deleted: num?.deleted ?? 0,
      binary: num?.binary ?? false,
      ...(mode !== undefined ? { newMode: mode } : {}),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * File modes of the blobs directly inside `dir` at `sha` (non-recursive; `dir` = ''
 * means the repo root). Missing/unreadable directory -> empty list, never throws:
 * the exec-bit gate treats "no evidence" as "no opinion".
 */
export function listDirFileModes(cwd: string, sha: string, dir: string): { name: string; mode: string }[] {
  const spec = dir === '' || dir === '.' ? `${sha}:` : `${sha}:${dir}`;
  const r = tryGit(cwd, ['ls-tree', '-z', spec]);
  if (!r.ok) return [];
  const out: { name: string; mode: string }[] = [];
  for (const line of splitNul(r.stdout)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type] = line.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === undefined) continue;
    const full = line.slice(tab + 1);
    out.push({ name: full.slice(full.lastIndexOf('/') + 1), mode });
  }
  return out;
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

/**
 * Create a per-task worktree on a new branch.
 *
 * @deprecated Executors work in the repository root on a `router/<id>` branch. Kept only for
 * the rollback window in DEPRECATIONS.md, and guarded so it cannot be reached by accident: two
 * live execution paths that behave differently is precisely the bug that is hard to find later.
 * `worktreeAddDetached` is NOT deprecated -- the verifier's throwaway patch-check worktree is a
 * different thing and stays.
 */
export function worktreeAdd(cwd: string, path: string, branch: string, base: string): void {
  // An escape hatch rather than dead code, so "kept for one version" means something you can
  // actually do: set ROUTER_ALLOW_WORKTREE_MODE=1. Refusing by default is the point -- a
  // deprecated path that still runs silently gives you two execution models with different
  // behaviour and no way to tell which one produced a result.
  if (process.env.ROUTER_ALLOW_WORKTREE_MODE !== '1') {
    throw new Error(
      'worktreeAdd is deprecated: executors run in the repository root on a router/<id> branch. ' +
        'Use createBranchStrict. To re-enable during the rollback window, set ' +
        'ROUTER_ALLOW_WORKTREE_MODE=1 (see DEPRECATIONS.md).',
    );
  }
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


/** Stage everything and commit; returns false (no commit) if the tree is clean.
 * Carries its own committer identity via -c so this bookkeeping commit never
 * depends on ambient git config (fresh containers / CI often have none); the
 * commit is throwaway anyway - `land` re-integrates the diff with `merge --no-ff`. */
export function commitAll(cwd: string, message: string): boolean {
  git(cwd, ['add', '-A']);
  if (git(cwd, ['diff', '--cached', '--name-only']).trim() === '') return false;
  git(cwd, ['-c', 'user.name=router', '-c', 'user.email=router@localhost', 'commit', '-q', '-m', message]);
  return true;
}

/** Whether the working tree holds any change at all (tracked edits or untracked files).
 * A run that ends badly is not committed, so this is how the caller can say "the work is
 * still there" instead of leaving the user to discover it -- an executor killed after it
 * finished is the case that matters. Best effort: unreadable tree reports clean. */
export function worktreeDirty(cwd: string): boolean {
  const r = tryGit(cwd, ['status', '--porcelain']);
  return r.ok && r.stdout.trim() !== '';
}

/**
 * Whether TRACKED content has uncommitted modifications -- the only thing that a checkout or
 * a `reset --hard` would overwrite, and therefore the only thing worth refusing to borrow a
 * checkout over. Untracked files survive both (we never `git clean`), and submodule *content*
 * dirt is build output, not the user's work.
 *
 * The distinction is not academic: measured on a real ClickHouse checkout, plain
 * `git status --porcelain` reported 110 entries, of which 107 were build residue inside
 * `contrib/*` submodules and 2 were untracked scratch files. Exactly one was a real
 * uncommitted edit. Refusing on all 110 would lock the verification queue out of the very
 * kind of project it was built for; refusing on the one is right.
 *
 * A submodule *pointer* move is a real tracked change and still counts.
 */
export function trackedChanges(cwd: string): string[] {
  const r = tryGit(cwd, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=dirty']);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** Hard-reset a worktree to `sha` and remove untracked files - used to give the
 * next executor in a fallback chain a clean checkout after one quota-failed. */
export function resetHard(cwd: string, sha: string): void {
  git(cwd, ['reset', '--hard', sha]);
  git(cwd, ['clean', '-fd']);
}

/** Reset tracked files and HEAD only. Queue gates must preserve warm untracked artifacts. */
export function resetHardTracked(cwd: string, sha: string): void {
  git(cwd, ['reset', '--hard', sha]);
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

/**
 * Point `ref` at `sha`. Used to make a salvage commit reachable before a reset discards the
 * branch tip that held it -- an unreachable commit is recoverable only by sha, and only until
 * `git gc` runs. A ref survives both.
 */
export function updateRef(cwd: string, ref: string, sha: string): void {
  git(cwd, ['update-ref', ref, sha]);
}

export function deleteBranch(cwd: string, branch: string): void {
  tryGit(cwd, ['branch', '-D', branch]);
}

// ---------------------------------------------------------------------------
// Branch-mode primitives (P2).
//
// The execution model moved out of a per-task worktree and into the user's own
// checkout on a dedicated branch, which changes what "safe" means. In a worktree a
// mistake could only destroy a throwaway directory; here every destructive step is
// one directory away from the user's uncommitted work. These are the primitives the
// dispatch flow is required to go through, and the reason each exists is the specific
// way the old primitive was unsafe.
// ---------------------------------------------------------------------------

/** A task's identity assertion failed: we are not where the task record says we are. */
export class TaskIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskIdentityError';
  }
}

/**
 * Create `branch` at HEAD and check it out. Refuses when the name is already taken.
 *
 * `checkoutBranch` silently checks out an existing same-named branch instead, which was
 * harmless while each task owned a worktree and became a data-loss path once tasks share
 * the user's checkout: a re-dispatch under a recycled task id would adopt a stale branch,
 * and the retry path's `reset --hard` would then discard commits that belong to whatever
 * ran there before. "The branch exists" also does not mean "the same task" -- identity is
 * branch + base_sha + session, so the caller has to decide between resume and a new id.
 */
export function createBranchStrict(cwd: string, branch: string): void {
  if (branchExists(cwd, branch)) {
    throw new TaskIdentityError(
      `branch ${branch} already exists; refusing to reuse it. Resume that task, or dispatch under a different task id.`,
    );
  }
  git(cwd, ['checkout', '--quiet', '-b', branch, 'HEAD']);
}

/** The checked-out branch, or null when HEAD is detached (a Git detached head, not a detached process). */
export function currentBranch(cwd: string): string | null {
  const r = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

/** Whether `ancestor` is reachable from `descendant`. Unreadable refs report false. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;
}

/**
 * Porcelain entries whose dirt is submodule *content* rather than a tracked change of ours.
 *
 * Kept separate because it is neither the user's work (so rescuing it is impossible -- the
 * changes live in another repository) nor a reason to refuse (measured on a real ClickHouse
 * checkout: 107 of 110 porcelain entries were build residue inside `contrib/*`). The caller
 * reports these on their own line instead of pretending the tree is clean or bailing out.
 */
export function submoduleDirty(cwd: string, exclude: readonly string[] = []): string[] {
  const scope = pathspec(exclude);
  const all = tryGit(cwd, ['status', '--porcelain', ...scope]);
  // [] on failure is acceptable HERE, unlike uncommittedSourceFiles: nothing decides on this
  // value. It feeds one advisory report line, and the run's real safety checks fail loudly on
  // the same broken repository a moment later.
  if (!all.ok) return [];
  const ignoring = new Set(
    tryGit(cwd, ['status', '--porcelain', '--ignore-submodules=dirty', ...scope]).stdout.split('\n'),
  );
  return all.stdout.split('\n').filter((line) => line !== '' && !ignoring.has(line));
}

/**
 * Turn exclusion pathspecs into a `git` argument tail, or nothing when there are none.
 *
 * Callers pass these to keep router's OWN state out of a commit made on the user's behalf.
 * `.router/` carries a `*` gitignore, so in a well-formed repo it is invisible anyway -- but
 * "the user's uncommitted work" and "orchestration state" must not be one decision away from
 * each other, and a missing or edited .gitignore would otherwise commit router's bookkeeping
 * into the user's history.
 */
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

/**
 * The same question for a caller that is reporting rather than deciding, where a failure must
 * not mask the failure being reported. `null` means "could not determine" and is deliberately
 * distinct from `[]`, which means "nothing uncommitted".
 */
export function uncommittedSourceFilesOrUnknown(
  cwd: string,
  exclude: readonly string[] = [],
): string[] | null {
  try {
    return uncommittedSourceFiles(cwd, exclude);
  } catch {
    return null;
  }
}

/**
 * Stage tracked edits plus non-ignored untracked files and commit them, returning the commit
 * and the paths it captured. Returns null when there is nothing to rescue -- deliberately, so
 * a clean checkout does not gain an empty commit.
 *
 * This is how the flow keeps its first Must NOT ("never lose the user's uncommitted work")
 * before it starts moving branches around. `git stash` was rejected for the job: a stash is
 * detached from the branch, and a pop that conflicts on the failure path leaves the user's
 * changes suspended somewhere they have to be told about. A commit is on their branch,
 * visible in `git log`, and undone with `reset --soft HEAD~1`.
 *
 * Carries its own committer identity via -c, so bookkeeping never depends on ambient git
 * config -- fresh containers and CI images often have none.
 */
export function rescueCommit(
  cwd: string,
  message: string,
  exclude: readonly string[] = [],
): { sha: string; files: string[] } | null {
  const before = uncommittedSourceFiles(cwd, exclude);
  if (before.length === 0) return null;
  // Stage everything, then UNSTAGE the exclusions -- rather than handing `git add` an
  // exclusion pathspec, which is what this used to do.
  //
  // Found by a real end-to-end dispatch, not by reasoning: `git add -A -- .
  // ':(exclude,glob).router'` **exits 1** when `.router` is also matched by a .gitignore rule.
  // Git staged exactly the right files and then failed anyway, because naming a path in a
  // pathspec at all -- even to exclude it -- makes it "explicitly listed", and an explicitly
  // listed ignored path is an error. So the dispatch aborted on every project that gitignores
  // `.router`, which is every project that has ever run router. `git status` has no such rule,
  // which is why the check that decides *whether* to rescue was unaffected and the failure
  // landed on the write.
  //
  // Reset-after-add has neither problem: it exits 0 whether or not the path is ignored, stages
  // the identical set, and is a no-op when nothing from the exclusions was staged.
  git(cwd, ['add', '-A']);
  for (const path of exclude) tryGit(cwd, ['reset', '-q', '--', path]);
  const staged = git(cwd, ['diff', '--cached', '--name-only', '-z']);
  const files = splitNul(staged);
  if (files.length === 0) return null; // e.g. only submodule content was dirty
  git(cwd, [
    '-c',
    'user.name=router',
    '-c',
    'user.email=router@localhost',
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return { sha: resolveCommit(cwd, 'HEAD'), files };
}

/**
 * Assert we are exactly where the task record says before anything destructive runs.
 *
 * Two separate failures, both of which the old worktree model made impossible and the branch
 * model makes reachable: the user checking out something else mid-run, and a same-named branch
 * that belongs to a different task. Either one aimed at `reset --hard` destroys work that was
 * never part of this task, so this throws rather than reporting.
 */
export function assertTaskIdentity(cwd: string, task: { branch: string; baseSha: string }): void {
  const on = currentBranch(cwd);
  if (on === null) {
    throw new TaskIdentityError(
      `HEAD is detached; task ${task.branch} requires its own branch to be checked out.`,
    );
  }
  if (on !== task.branch) {
    throw new TaskIdentityError(`on branch ${on}, but task requires ${task.branch}.`);
  }
  if (!isAncestor(cwd, task.baseSha, 'HEAD')) {
    throw new TaskIdentityError(
      `base_sha ${task.baseSha.slice(0, 12)} is not an ancestor of HEAD on ${task.branch}; ` +
        `the branch was reset or rewritten outside this task.`,
    );
  }
}
