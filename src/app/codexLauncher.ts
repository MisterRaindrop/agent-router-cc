// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { WorkerPolicy } from '../domain/types.ts';
import type { WorkerContext, WorkerLauncher } from './worker.ts';
import { parseClaudeLog, parseCodexLog } from './usage.ts';

// Builds the codex-cli invocation for one executor. Non-interactive `codex exec`,
// pinned to the worktree, workspace-write sandbox, JSONL events (token usage +
// model -> metrics). The binary is `codex` by default; ROUTER_CODEX_BIN overrides
// it (used by tests to substitute a fake worker without real codex).

export function codexLauncher(worker: Pick<WorkerPolicy, 'model'>): WorkerLauncher {
  const bin = process.env.ROUTER_CODEX_BIN ?? 'codex';
  const model = worker.model;
  return {
    kind: 'codex',
    ...(model !== undefined ? { model } : {}),
    parseLog: parseCodexLog,
    buildArgv(ctx: WorkerContext): string[] {
      const argv = [
        bin,
        'exec',
        buildPrompt(ctx),
        '-C',
        ctx.worktreeDir,
        '-s',
        'workspace-write',
        '--skip-git-repo-check',
        '--json',
      ];
      if (model !== undefined) argv.push('-m', model);
      return argv;
    },
  };
}

// The claude CLI as a headless executor: `claude -p ... --output-format stream-json`
// with permissions bypassed (safe: isolated worktree + diff-scope gate, same as
// codex workspace-write). Plan-auth via ~/.claude, no API key. ROUTER_CLAUDE_BIN
// overrides the binary (tests). Cost comes from the stream's total_cost_usd.
export function claudeLauncher(worker: Pick<WorkerPolicy, 'model'>): WorkerLauncher {
  const bin = process.env.ROUTER_CLAUDE_BIN ?? 'claude';
  const model = worker.model;
  return {
    kind: 'claude',
    ...(model !== undefined ? { model } : {}),
    parseLog: parseClaudeLog,
    buildArgv(ctx: WorkerContext): string[] {
      const argv = [
        bin,
        '-p',
        buildPrompt(ctx),
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--add-dir',
        ctx.worktreeDir,
      ];
      if (model !== undefined) argv.push('--model', model);
      return argv;
    },
  };
}

// Executor factory: map a policy worker entry to its launcher.
export function makeLauncher(worker: WorkerPolicy): WorkerLauncher {
  switch (worker.kind) {
    case 'codex':
      return codexLauncher(worker);
    case 'claude':
      return claudeLauncher(worker);
    default:
      throw new Error(`unsupported worker kind: ${String(worker.kind)}`);
  }
}

function buildPrompt(ctx: WorkerContext): string {
  const scope = ctx.task.allowed_globs.join(', ');
  return (
    `${ctx.contractMdText.trim()}\n\n` +
    `Constraints:\n` +
    `- Change ONLY files matching: ${scope}\n` +
    `- Do not touch tests except to make them pass legitimately.\n` +
    `- Leave changes in the working tree; the orchestrator will commit them.\n`
  );
}
