// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { RunResult } from '../domain/types.ts';
import { branchExists, rawDiff, resolveCommit } from '../io/git.ts';

// What a stored PASSED verdict actually authorizes.
//
// It used to authorize the BRANCH, with nothing tying the verdict to a commit -- so anything
// appended after the verdict (a `router resume` whose own closeout failed, the user committing by
// hand, a concurrent `git update-ref`) was merged on the strength of a verdict that had never
// seen it. The reviewer landed `x = 3` in main that way.
//
// This lives in its own module because the first fix put the check in `land` alone, and there are
// TWO merge paths: `router land` and the queue gate, which merges the run branch into an
// integration branch. Fixing one and not the other left the identical hole open a command away.
// Anything that merges a run branch on the strength of `result.json` calls this first, and merges
// the SHA it hands back -- never the branch name it was given.

export type HeadPin = { ok: true; sha: string } | { ok: false; reason: string };

/**
 * The exact commit a run's verdict covers, or why the branch can no longer be trusted to be it.
 *
 * `verified_head` is the precise answer and is recorded from here on. A record written before
 * that field existed falls back to re-deriving the diff and comparing it against the `diff_sha`
 * the verifier stored: weaker (it cannot see an empty commit, and `git diff` output shifts with
 * config like `diff.algorithm`), but true of every record already on disk, so upgrading does not
 * silently trust exactly the records this finding was about.
 */
export function pinnedHead(repoRoot: string, branch: string, result: RunResult): HeadPin {
  if (!branchExists(repoRoot, branch)) {
    return {
      ok: false,
      reason:
        `branch ${branch} no longer exists` +
        (result.merge_commit !== undefined
          ? ` -- it was already landed as ${result.merge_commit.slice(0, 12)}`
          : ''),
    };
  }
  const tip = resolveCommit(repoRoot, branch);
  if (result.verified_head !== undefined) {
    if (tip === result.verified_head) return { ok: true, sha: tip };
    return {
      ok: false,
      reason: `${branch} is at ${tip.slice(0, 12)} but ${result.verified_head.slice(0, 12)} was verified`,
    };
  }
  if (result.base_sha === undefined || result.diff_sha === undefined) {
    return { ok: false, reason: `this run recorded no verified commit (it predates the check)` };
  }
  const now = createHash('sha256').update(rawDiff(repoRoot, result.base_sha, branch)).digest('hex');
  if (now !== result.diff_sha) {
    return { ok: false, reason: `${branch} no longer matches the diff that was verified` };
  }
  return { ok: true, sha: tip };
}
