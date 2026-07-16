// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifierCheck, VerifierReport } from '../domain/types.ts';
import { evaluateScope } from '../core/scope.ts';
import { scanSecrets } from '../core/secrets.ts';
import { applyCheck, collectDiff, rawDiff, worktreeAddDetached, worktreeRemove } from '../io/git.ts';
import { runCommand } from '../io/proc.ts';

// The mechanical verifier (policy-free). The task carries its own scope and verify
// command; checks run in order, fail-fast. Every gate the executor must clear lives
// here as deterministic code: diff applies, scope, secret scan, then the task's
// verify argv(s).

const DEFAULT_TEST_GLOBS = ['test/**', 'tests/**', '**/*.test.*', '**/*_test.*'];
const DEFAULT_MAX_CHANGED_LINES = 400;

function fail(id: string, detail: string, rc?: number): VerifierCheck {
  return rc !== undefined ? { id, ok: false, detail, rc } : { id, ok: false, detail };
}
function pass(id: string, detail?: string): VerifierCheck {
  return detail !== undefined ? { id, ok: true, detail } : { id, ok: true };
}

export interface TaskVerifyRequest {
  repoRoot: string;
  worktreeDir: string;
  baseSha: string;
  head: string;
  allowedGlobs: string[];
  forbiddenGlobs?: string[];
  maxChangedLines?: number;
  verify: string[][]; // argv list; [] = diff/scope/secret only
  env: NodeJS.ProcessEnv;
  secretExtraPatterns?: string[];
  buildTimeoutMs?: number;
}

export function verifyTask(req: TaskVerifyRequest): VerifierReport {
  const checks: VerifierCheck[] = [];

  const changes = collectDiff(req.worktreeDir, req.baseSha, req.head);
  const patch = rawDiff(req.worktreeDir, req.baseSha, req.head);
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

  for (const [i, argv] of req.verify.entries()) {
    if (argv.length === 0) continue;
    const r = runCommand(argv, {
      cwd: req.worktreeDir,
      env: req.env,
      ...(req.buildTimeoutMs !== undefined ? { timeoutMs: req.buildTimeoutMs } : {}),
    });
    const label = req.verify.length > 1 ? `verify[${i}]` : 'verify';
    if (r.spawnError !== null) {
      checks.push(fail(label, `spawn error: ${r.spawnError}`));
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
    }
    if (r.timedOut) {
      checks.push(fail(label, 'timed out'));
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
    }
    if (r.rc !== 0) {
      checks.push(fail(label, `${argv.join(' ')} (rc ${r.rc})`, r.rc ?? undefined));
      return { result: 'FAILED', checks, changed_lines: verdict.changedLines };
    }
    checks.push(pass(label, `${argv.join(' ')} (rc 0)`));
  }

  return { result: 'PASSED', checks, changed_lines: verdict.changedLines };
}
