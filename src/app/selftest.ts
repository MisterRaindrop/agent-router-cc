// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskState } from '../domain/types.ts';
import { systemClock } from '../io/clock.ts';
import { resolveCommit } from '../io/git.ts';
import { routerPaths, type RouterPaths } from '../io/paths.ts';
import { hashContract } from '../core/contractHash.ts';
import { createTask, currentState, transition, type TransitionDeps } from './transition.ts';
import { runWorkerBody, startRun, type WorkerLauncher } from './worker.ts';

// `router selftest`: three canaries in a throwaway sandbox. Two must PASS, and
// one - the trap - MUST be caught and FAIL by the scope check. This is the live
// proof that the gates actually stop a "confused LLM"; it doubles as CI.

const NODE = process.execPath;
const OK = `[${JSON.stringify(NODE)}, "-e", "process.exit(0)"]`;

const POLICY = `schema_version: 1
max_concurrent_workers: 1
worker:
  kind: codex
  api_key_env: OPENAI_API_KEY
  stall_minutes: 1
scope:
  forbidden_globs: []
  test_globs: ["tests/**"]
  max_changed_lines: 400
verification:
  build:
    - ${OK}
  test:
    - ${OK}
`;

const CONTRACT = '# Contract\nselftest canary\n';

export interface CanaryResult {
  name: string;
  expected: 'PASSED' | 'FAILED';
  actual: TaskState;
  ok: boolean;
  detail: string;
}
export interface SelftestResult {
  ok: boolean;
  canaries: CanaryResult[];
  sandbox: string | null;
}

function gitInit(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'selftest@router.local']);
  run(['config', 'user.name', 'router selftest']);
  run(['config', 'commit.gpgsign', 'false']);
}

function makeSandbox(): { repo: string; deps: TransitionDeps; paths: RouterPaths } {
  const repo = mkdtempSync(join(tmpdir(), 'router-selftest-'));
  gitInit(repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 't.test.ts'), 'ok\n');
  mkdirSync(join(repo, '.router'), { recursive: true });
  writeFileSync(join(repo, '.router', 'policy.yaml'), POLICY);
  writeFileSync(join(repo, '.gitignore'), '.router/worktrees/\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repo, stdio: 'ignore' });
  const paths = routerPaths(join(repo, '.router'));
  return { repo, deps: { paths, clock: systemClock }, paths };
}

function taskYaml(id: string, allowed: string[]): string {
  return `schema_version: 1
id: ${id}
title: ${id}
base_sha: null
max_wall_minutes: 1
allowed_globs: ${JSON.stringify(allowed)}
build_ref: build
test_ref: test
`;
}

function validateQueue(deps: TransitionDeps, repo: string, id: string, yamlText: string): void {
  const base = resolveCommit(repo, 'HEAD');
  mkdirSync(deps.paths.taskDir(id), { recursive: true });
  writeFileSync(deps.paths.taskYaml(id), yamlText);
  writeFileSync(deps.paths.contractMd(id), CONTRACT);
  const hash = hashContract(yamlText, CONTRACT);
  createTask(deps, id, id);
  transition(deps, id, 'VALIDATED', { actor: 'selftest', meta: { base_sha: base, contract_hash: hash } });
  transition(deps, id, 'QUEUED', { actor: 'selftest' });
}

const scriptLauncher = (script: string): WorkerLauncher => ({
  kind: 'codex',
  model: 'selftest',
  buildArgv: () => [NODE, '-e', script],
});

interface Canary {
  name: string;
  expected: 'PASSED' | 'FAILED';
  allowed: string[];
  script: string;
}

const CANARIES: Canary[] = [
  {
    name: 'trivial-fix',
    expected: 'PASSED',
    allowed: ['src/**'],
    script: 'require("fs").writeFileSync("src/a.ts","export const x = 2;\\n")',
  },
  {
    name: 'constrained-refactor',
    expected: 'PASSED',
    allowed: ['src/**'],
    script:
      'const fs=require("fs");fs.writeFileSync("src/a.ts","export const x = 3;\\n");fs.writeFileSync("src/b.ts","export const y = 1;\\n")',
  },
  {
    name: 'scope-trap',
    expected: 'FAILED', // worker exits 0 but writes OUTSIDE allowed_globs
    allowed: ['src/**'],
    script:
      'const fs=require("fs");fs.mkdirSync("secrets",{recursive:true});fs.writeFileSync("secrets/leak.txt","escaped\\n")',
  },
];

export async function selftest(opts: { keep?: boolean } = {}): Promise<SelftestResult> {
  const { repo, deps, paths } = makeSandbox();
  const canaries: CanaryResult[] = [];
  try {
    for (const c of CANARIES) {
      validateQueue(deps, repo, c.name, taskYaml(c.name, c.allowed));
      const { runId } = startRun(deps, c.name);
      const result = await runWorkerBody(deps, c.name, runId, scriptLauncher(c.script));
      const actual = currentState(paths, c.name)?.state ?? 'DRAFT';
      const scopeCaught =
        result.verifier?.checks.some((ch) => ch.id === 'scope' && !ch.ok) ?? false;
      const ok =
        actual === c.expected &&
        (c.name !== 'scope-trap' || (actual === 'FAILED' && scopeCaught));
      canaries.push({
        name: c.name,
        expected: c.expected,
        actual,
        ok,
        detail:
          c.name === 'scope-trap'
            ? `scope violation caught=${scopeCaught}`
            : `exit=${result.exit_class} verifier=${result.verifier?.result ?? 'n/a'}`,
      });
    }
    return { ok: canaries.every((c) => c.ok), canaries, sandbox: opts.keep ? repo : null };
  } finally {
    if (!opts.keep) rmSync(repo, { recursive: true, force: true });
  }
}
