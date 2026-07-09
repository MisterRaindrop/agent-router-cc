import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy, TaskYaml, VerifierCheck, VerifierReport } from '../domain/types.ts';
import { buildEffectiveScope, evaluateScope } from '../core/scope.ts';
import { instantiateTemplate } from '../core/whitelist.ts';
import { hashContract } from '../core/contractHash.ts';
import { applyCheck, collectDiff, rawDiff, worktreeAddDetached, worktreeRemove } from '../io/git.ts';
import { runCommand } from '../io/proc.ts';

// The mechanical verifier: five checks, in order, fail-fast. Every gate the LLM
// must clear lives here as deterministic code. Policy is passed in already loaded
// from the base_sha git object (app/policyLoad), so the worker cannot influence
// the whitelist or scope by editing its worktree.

export interface VerifyRequest {
  repoRoot: string; // main repo (for the temp base-worktree in check 1)
  worktreeDir: string; // where the worker's run branch is checked out
  baseSha: string;
  head: string; // ref inside worktreeDir, normally 'HEAD'
  policy: Policy;
  task: TaskYaml;
  frozenContractHash: string;
  taskYamlText: string; // current .router/tasks/<id>/task.yaml content
  contractMdText: string; // current .router/tasks/<id>/TASK_CONTRACT.md content
  env: NodeJS.ProcessEnv; // whitelisted env for build/test
  buildTimeoutMs?: number;
}

function fail(id: string, detail: string, rc?: number): VerifierCheck {
  return rc !== undefined ? { id, ok: false, detail, rc } : { id, ok: false, detail };
}
function pass(id: string, detail?: string): VerifierCheck {
  return detail !== undefined ? { id, ok: true, detail } : { id, ok: true };
}

function runRef(
  req: VerifyRequest,
  ref: string,
): { ok: boolean; detail: string; rc: number | null } {
  const templates = req.policy.verification[ref];
  if (templates === undefined || templates.length === 0) {
    return { ok: false, detail: `no verification template for ref '${ref}'`, rc: null };
  }
  const inst = instantiateTemplate(templates[0]!, req.task.verification_params ?? {});
  if (!inst.ok || inst.argv === null) {
    return { ok: false, detail: `command not whitelisted: ${inst.errors.join('; ')}`, rc: null };
  }
  const r = runCommand(inst.argv, {
    cwd: req.worktreeDir,
    env: req.env,
    ...(req.buildTimeoutMs !== undefined ? { timeoutMs: req.buildTimeoutMs } : {}),
  });
  if (r.spawnError !== null) return { ok: false, detail: `spawn error: ${r.spawnError}`, rc: null };
  if (r.timedOut) return { ok: false, detail: `timed out`, rc: null };
  return { ok: r.rc === 0, detail: `${inst.argv.join(' ')} (rc ${r.rc})`, rc: r.rc };
}

export function verify(req: VerifyRequest): VerifierReport {
  const checks: VerifierCheck[] = [];
  let changedLines: number | undefined;

  // 1. diff non-empty & applies cleanly onto a fresh base tree.
  const changes = collectDiff(req.worktreeDir, req.baseSha, req.head);
  const patch = rawDiff(req.worktreeDir, req.baseSha, req.head);
  if (patch.trim() === '') {
    checks.push(fail('diff_applies', 'diff is empty — worker produced no committed change'));
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

  // 2. scope enforcement.
  const scope = buildEffectiveScope(req.task, req.policy);
  const verdict = evaluateScope(changes, scope);
  changedLines = verdict.changedLines;
  if (!verdict.ok) {
    checks.push(fail('scope', verdict.violations.map((v) => `${v.kind}:${v.path ?? ''}`).join(', ')));
    return { result: 'FAILED', checks, changed_lines: changedLines };
  }
  checks.push(pass('scope', `${verdict.changedLines} lines`));

  // 3. build.
  const build = runRef(req, req.task.build_ref);
  checks.push(build.ok ? pass('build', build.detail) : fail('build', build.detail, build.rc ?? undefined));
  if (!build.ok) return { result: 'FAILED', checks, changed_lines: changedLines };

  // 4. test.
  const test = runRef(req, req.task.test_ref);
  checks.push(test.ok ? pass('test', test.detail) : fail('test', test.detail, test.rc ?? undefined));
  if (!test.ok) return { result: 'FAILED', checks, changed_lines: changedLines };

  // 5. contract hash unchanged since VALIDATED.
  const recomputed = hashContract(req.taskYamlText, req.contractMdText);
  if (recomputed !== req.frozenContractHash) {
    checks.push(fail('contract_hash', 'frozen contract was modified after validation'));
    return { result: 'FAILED', checks, changed_lines: changedLines };
  }
  checks.push(pass('contract_hash'));

  return { result: 'PASSED', checks, changed_lines: changedLines };
}
