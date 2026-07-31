// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { TaskYaml, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import { parseClaudeLog, parseCodexLog, type ParsedLog } from './usage.ts';

// A launcher turns a run context into the executor argv. Tests inject a fake that
// edits files directly (ROUTER_CODEX_BIN / ROUTER_CLAUDE_BIN).
export interface WorkerContext {
  task: TaskYaml;
  worktreeDir: string;
  contractMdText: string;
  planExists: boolean;
}
export interface WorkerLauncher {
  kind: WorkerKind;
  model?: string;
  buildArgv(ctx: WorkerContext): string[];
  /**
   * Argv to RESUME a prior session (context retained) with a follow-up message,
   * instead of a cold restart. `router resume` compares the resumed run's reported
   * session id back to `sessionId` to prove it re-attached.
   */
  buildResumeArgv(worktreeDir: string, sessionId: string, feedback: string): string[];
  /** Parse this executor's own log for usage/model/cost. Defaults to codex. */
  parseLog?: (log: string) => ParsedLog;
}

// Builds the codex-cli invocation for one executor. Non-interactive `codex exec`,
// pinned to the worktree, workspace-write sandbox, JSONL events (token usage +
// model -> metrics). The binary is `codex` by default; ROUTER_CODEX_BIN overrides
// it (used by tests to substitute a fake worker without real codex).

export function codexLauncher(worker: Pick<WorkerPolicy, 'model' | 'effort'>): WorkerLauncher {
  const bin = process.env.ROUTER_CODEX_BIN ?? 'codex';
  const model = worker.model;
  const effort = worker.effort;
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
      if (effort !== undefined) argv.push('-c', `model_reasoning_effort=${effort}`);
      return argv;
    },
    // `codex exec resume <session-id> <prompt>` continues that rollout. The exact
    // resume flag can vary by codex version; the session-id continuity guard in
    // `router resume` catches a wrong invocation instead of silently not resuming.
    buildResumeArgv(worktreeDir: string, sessionId: string, feedback: string): string[] {
      const argv = [
        bin,
        'exec',
        'resume',
        sessionId,
        feedback,
        '-C',
        worktreeDir,
        '-s',
        'workspace-write',
        '--skip-git-repo-check',
        '--json',
      ];
      if (model !== undefined) argv.push('-m', model);
      if (effort !== undefined) argv.push('-c', `model_reasoning_effort=${effort}`);
      return argv;
    },
  };
}

// The claude CLI as a headless executor. It gets Read/Edit/Write tools and normal
// edit-acceptance permissions: reads outside the worktree are denied. A task with a
// gate also gets only those exact verify commands pre-approved for Bash. The narrow
// grant lets the executor prove its own work; it does not give the executor a shell.
// Router still verifies independently afterward. Plan-auth comes from the user's
// Claude session; ROUTER_CLAUDE_BIN overrides the binary in tests. Cost comes from
// the stream's total_cost_usd.
export function claudeLauncher(worker: Pick<WorkerPolicy, 'model' | 'effort'>): WorkerLauncher {
  const bin = process.env.ROUTER_CLAUDE_BIN ?? 'claude';
  const model = worker.model;
  const effort = worker.effort;
  return {
    kind: 'claude',
    ...(model !== undefined ? { model } : {}),
    parseLog: parseClaudeLog,
    buildArgv(ctx: WorkerContext): string[] {
      const verifyCommands = (ctx.task.verify ?? [])
        .filter((command) => command.length > 0)
        .map((command) => command.join(' '));
      const argv = [
        bin,
        '-p',
        buildPrompt(ctx),
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--tools',
        verifyCommands.length > 0 ? 'Read,Edit,Write,Bash' : 'Read,Edit,Write',
        '--add-dir',
        ctx.worktreeDir,
      ];
      if (verifyCommands.length > 0) {
        argv.push('--allowedTools', ...verifyCommands.map((command) => `Bash(${command})`));
      }
      if (model !== undefined) argv.push('--model', model);
      if (effort !== undefined) argv.push('--effort', effort);
      return argv;
    },
    // `claude --resume <session-id> -p <feedback>` continues that session with its
    // context retained. The session-id continuity guard in `router resume` verifies
    // it re-attached.
    buildResumeArgv(worktreeDir: string, sessionId: string, feedback: string): string[] {
      const argv = [
        bin,
        '-p',
        feedback,
        '--resume',
        sessionId,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--tools',
        'Read,Edit,Write',
        '--add-dir',
        worktreeDir,
      ];
      if (model !== undefined) argv.push('--model', model);
      if (effort !== undefined) argv.push('--effort', effort);
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

// The executor owns the whole task, so the prompt says so explicitly: implement, test, run
// the gate, and fix to green inside this one session. Splitting that loop across dispatches
// costs a cold start (the executor re-reads the repository from scratch) plus an orchestrator
// review round trip, and the orchestrator's turns are the expensive resource.
//
// Two protocols ride along, both carried by the FINAL message so nothing is ever written into
// the worktree (which would show up in the diff and trip the scope gate): a delivery report,
// and `CONTRACT_CONFLICT` for when the code contradicts the plan. An executor that quietly
// works around a wrong contract is the failure this exists to prevent.
function buildPrompt(ctx: WorkerContext): string {
  const scope = ctx.task.allowed_globs.join(', ');
  const gate = (ctx.task.verify ?? []).filter((argv) => argv.length > 0).map((argv) => argv.join(' '));
  const gateStep =
    gate.length > 0
      ? `run the project gate yourself (${gate.map((g) => `\`${g}\``).join(', ')}), read what it ` +
        `reports and fix until it passes`
      : `note that NO gate runs here -- the orchestrator runs the real build and tests later in ` +
        `its own environment, so write the tests but do not try to build this project`;
  const planRevision = ctx.task.plan_id ?? 'none';
  return (
    `${ctx.contractMdText.trim()}\n\n` +
    `You own this task start to finish: read the code you are about to change, decide your own\n` +
    `internal steps, implement it, write tests for what you changed, ${gateStep}, then check your\n` +
    `own diff against the scope below before finishing.\n\n` +
    `Constraints:\n` +
    `- Change ONLY files matching: ${scope}\n` +
    `- Do not touch tests except to make them pass legitimately.\n` +
    `- Leave changes in the working tree; the orchestrator will commit them.\n` +
    `- Do NOT set up the environment to make a check run: no installing dependencies, no\n` +
    `  creating directories, no editing configuration. If a check cannot run here, say so in\n` +
    `  the report -- an honest "did not run" is useful, a claimed pass that never ran is not.\n` +
    `- Do NOT change the plan or this contract. If the code contradicts it -- a stated\n` +
    `  assumption is false, a public interface would have to change, an invariant cannot hold,\n` +
    `  the acceptance bar conflicts with what the platform can do, or the work does not fit the\n` +
    `  scope -- then STOP, undo any experiment, and make your final message begin with the\n` +
    `  single line CONTRACT_CONFLICT followed by: the original assumption, the evidence you\n` +
    `  found, which plan item or invariant it conflicts with, which other work this affects,\n` +
    `  the options you see, and whether any experimental code is left behind.\n\n` +
    `Finish with a DELIVERY REPORT as your final message: a few sentences a human can read --\n` +
    `what you implemented, which modules you touched, which checks you ran and their results,\n` +
    `and anything risky or unresolved -- followed by exactly this block:\n\n` +
    '```router-delivery\n' +
    `task: ${ctx.task.id}\n` +
    `plan_revision: ${planRevision}\n` +
    `gate_ran: true|false\n` +
    `scope_drift: true|false\n` +
    `escalate_review: true|false\n` +
    '```\n\n' +
    `\`gate_ran\` is whether you actually ran the gate above and it passed. \`scope_drift\` is\n` +
    `whether you had to touch anything outside the scope. \`escalate_review\` is whether this\n` +
    `deserves a closer review than usual. Report all three honestly; they are read, not audited.\n`
  );
}
