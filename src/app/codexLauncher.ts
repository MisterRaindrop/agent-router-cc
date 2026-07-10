// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { WorkerPolicy } from '../domain/types.ts';
import type { WorkerContext, WorkerLauncher } from './worker.ts';

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

// Executor factory: map a policy worker entry to its launcher. Only codex today;
// new kinds (a claude/sonnet CLI or API executor) are added here.
export function makeLauncher(worker: WorkerPolicy): WorkerLauncher {
  switch (worker.kind) {
    case 'codex':
      return codexLauncher(worker);
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
