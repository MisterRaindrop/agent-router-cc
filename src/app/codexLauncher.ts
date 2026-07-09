import type { Policy } from '../domain/types.ts';
import type { WorkerContext, WorkerLauncher } from './worker.ts';

// Builds the codex-cli invocation for a run. Non-interactive `codex exec`, pinned
// to the worktree, workspace-write sandbox, JSONL events (token usage → metrics
// in M2). The binary is `codex` by default; ROUTER_CODEX_BIN overrides it (used
// by tests to substitute a fake worker without real codex).

export function codexLauncher(policy: Policy, opts: { model?: string } = {}): WorkerLauncher {
  const bin = process.env.ROUTER_CODEX_BIN ?? 'codex';
  const model = opts.model ?? policy.worker?.model;
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
