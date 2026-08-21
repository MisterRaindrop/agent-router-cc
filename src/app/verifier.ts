// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifierCheck, VerifierReport } from '../domain/types.ts';
import { evaluateScope } from '../core/scope.ts';
import { scanSecrets } from '../core/secrets.ts';
import { dirOf, extensionOf, findExecBitViolations, type ExecBitInput } from '../core/execBit.ts';
import {
  applyCheck,
  collectDiff,
  uncommittedSourceFiles,
  listDirFileModes,
  rawDiff,
  worktreeAddDetached,
  worktreeRemove,
} from '../io/git.ts';
import { runCommand } from '../io/proc.ts';

// The mechanical verifier (policy-free). The task carries its own scope and verify
// command; checks run in order, fail-fast. Every gate the executor must clear lives
// here as deterministic code: diff applies, scope, secret scan, then the task's
// verify argv(s).

const DEFAULT_TEST_GLOBS = ['test/**', 'tests/**', '**/*.test.*', '**/*_test.*'];
const DEFAULT_MAX_CHANGED_LINES = 400;

/**
 * Hard ceiling on ONE verify command, applied whether or not the caller asked for a timeout.
 *
 * It used to be opt-in, which was survivable while verification ran in a throwaway worktree:
 * a hung build wedged a directory nobody else wanted. Under the branch model the same hang
 * holds the exclusive lock on the user's own checkout, so `go` would sit on it forever with no
 * upper bound. 90 minutes is far above any real gate here (measured t_exec 393s for a whole
 * executor session) and far below "forever"; a project that genuinely needs longer sets
 * buildTimeoutMs explicitly.
 */
const DEFAULT_BUILD_TIMEOUT_MS = 90 * 60 * 1000;

function fail(id: string, detail: string, rc?: number): VerifierCheck {
  return rc !== undefined ? { id, ok: false, detail, rc } : { id, ok: false, detail };
}
function pass(id: string, detail?: string): VerifierCheck {
  return detail !== undefined ? { id, ok: true, detail } : { id, ok: true };
}

export interface TaskVerifyRequest {
  repoRoot: string;
  workDir: string;
  baseSha: string;
  head: string;
  mode?: 'implement' | 'probe';
  allowedGlobs: string[];
  forbiddenGlobs?: string[];
  maxChangedLines?: number;
  verify: string[][]; // argv list; [] = diff/scope/secret only
  /** Pathspecs excluded when looking for uncommitted files (router's own state). */
  uncommittedExclude?: readonly string[];
  env: NodeJS.ProcessEnv;
  secretExtraPatterns?: string[];
  buildTimeoutMs?: number;
}

export function verifyTask(req: TaskVerifyRequest): VerifierReport {
  const checks: VerifierCheck[] = [];

  const changes = collectDiff(req.workDir, req.baseSha, req.head);
  if (req.mode === 'probe') {
    // Committed changes AND uncommitted ones. A probe is required to write nothing at all, and
    // it is the one mode exempt from the closing "commit everything" invariant -- so an
    // uncommitted file is a probe violation to report here, not a leftover to sweep up.
    const touched = changes.length + uncommittedSourceFiles(req.workDir, req.uncommittedExclude ?? []).length;
    if (touched === 0) {
      checks.push(pass('probe_no_diff'));
      return { result: 'PASSED', checks };
    }
    const files = `${touched} file${touched === 1 ? '' : 's'}`;
    checks.push(fail('probe_no_diff', `probe wrote ${files}; expected no diff`));
    return { result: 'FAILED', checks };
  }

  const patch = rawDiff(req.workDir, req.baseSha, req.head);
  if (patch.trim() === '') {
    checks.push(fail('diff_applies', 'diff is empty - executor produced no committed change'));
    return { result: 'FAILED', checks };
  }
  const tmpBase = mkdtempSync(join(tmpdir(), 'router-verify-base-'));
  let applies: boolean;
  try {
    worktreeAddDetached(req.repoRoot, tmpBase, req.baseSha);
    applies = applyCheck(tmpBase, patch);
  } finally {
    worktreeRemove(req.repoRoot, tmpBase);
    rmSync(tmpBase, { recursive: true, force: true });
  }
  if (!applies) {
    checks.push(fail('diff_applies', 'patch does not apply cleanly onto base_sha'));
    return { result: 'FAILED', checks };
  }
  checks.push(pass('diff_applies'));

  const scope = {
    allowed_globs: req.allowedGlobs,
    forbidden_globs: req.forbiddenGlobs ?? [],
    test_globs: DEFAULT_TEST_GLOBS,
    max_changed_lines: req.maxChangedLines ?? DEFAULT_MAX_CHANGED_LINES,
  };
  const verdict = evaluateScope(changes, scope);
  if (!verdict.ok) {
    checks.push(fail('scope', verdict.violations.map((v) => `${v.kind}:${v.path ?? ''}`).join(', ')));
    return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
  }
  checks.push(pass('scope', `${verdict.changedLines} lines`));

  const findings = scanSecrets(patch, req.secretExtraPatterns ?? []);
  if (findings.length > 0) {
    checks.push(fail('secret_scan', `likely secret(s): ${findings.map((f) => `${f.rule}@L${f.line}`).join(', ')}`));
    return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
  }
  checks.push(pass('secret_scan'));

  // exec_bit: a file added without the executable bit into a directory whose existing
  // same-extension files are executable. Environment-free and deterministic, and the
  // failure it prevents ("permission denied" in CI) is invisible to every other gate.
  const execCandidates: ExecBitInput[] = [];
  for (const c of changes) {
    if ((c.status !== 'A' && c.status !== 'M') || c.newMode === undefined) continue;
    const ext = extensionOf(c.path);
    if (ext === '') continue; // no extension -> no sibling grouping to compare against
    const base = c.path.slice(c.path.lastIndexOf('/') + 1);
    const siblingModes = listDirFileModes(req.workDir, req.baseSha, dirOf(c.path))
      .filter((s) => s.name !== base && s.name.endsWith(ext))
      .map((s) => s.mode);
    execCandidates.push({ path: c.path, newMode: c.newMode, siblingModes });
  }
  const execViolations = findExecBitViolations(execCandidates);
  if (execViolations.length > 0) {
    const detail = execViolations
      .map((v) => `${v.path} is 100644 but ${v.execSiblings}/${v.totalSiblings} siblings are executable`)
      .join('; ');
    checks.push(fail('exec_bit', detail));
    return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
  }
  checks.push(pass('exec_bit'));

  for (const [i, argv] of req.verify.entries()) {
    if (argv.length === 0) continue;
    const r = runCommand(argv, {
      cwd: req.workDir,
      env: req.env,
      timeoutMs: req.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    });
    const label = req.verify.length > 1 ? `verify[${i}]` : 'verify';
    if (r.spawnError !== null) {
      checks.push(fail(label, `spawn error: ${r.spawnError}`));
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
    }
    if (r.timedOut) {
      const limitMs = req.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
      checks.push(fail(label, `timed out after ${Math.round(limitMs / 1000)}s: ${argv.join(' ')}`));
      // timed_out, not just FAILED: the command never returned a verdict, so this says nothing
      // about the change itself. The caller reports it as unverified rather than as a defect.
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines, timed_out: true };
    }
    if (r.rc !== 0) {
      checks.push(fail(label, `${argv.join(' ')} (rc ${r.rc})`, r.rc ?? undefined));
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
    }
    checks.push(pass(label, `${argv.join(' ')} (rc 0)`));
  }

  return { result: 'PASSED', checks, changed_lines: verdict.changedLines };
}
