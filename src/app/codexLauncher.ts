// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { TaskYaml, WorkerKind, WorkerPolicy } from '../domain/types.ts';
import { parseClaudeLog, parseCodexLog, type ParsedLog } from './usage.ts';

// A launcher turns a run context into the executor argv. Tests inject a fake that
// edits files directly (ROUTER_CODEX_BIN / ROUTER_CLAUDE_BIN).
export interface WorkerContext {
  task: TaskYaml;
  workDir: string;
  contractMdText: string;
  planExists: boolean;
  taskContext?: { text: string } | null;
}
export interface WorkerLauncher {
  kind: WorkerKind;
  model?: string;
  buildArgv(ctx: WorkerContext): string[];
  /**
   * Argv to RESUME a prior session (context retained) with a follow-up message,
   * instead of a cold restart. `router resume` compares the resumed run's reported
   * session id back to `sessionId` to prove it re-attached.
   *
   * `task` is needed because a resume is usually "the gate failed, fix it" -- so the resumed
   * run has to keep the same permission to run that gate. Without it the executor is asked to
   * fix a failure it is no longer allowed to reproduce.
   */
  buildResumeArgv(workDir: string, sessionId: string, feedback: string, task?: TaskYaml): string[];
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
        ctx.workDir,
        '-s',
        'workspace-write',
        '--skip-git-repo-check',
        '--json',
      ];
      if (model !== undefined) argv.push('-m', model);
      if (effort !== undefined) argv.push('-c', `model_reasoning_effort=${effort}`);
      return argv;
    },
    // `codex exec resume <session-id> <prompt>` continues that rollout. Its flags are NOT
    // the same as `codex exec`'s, which a real run proved: `exec resume` rejects `-C`
    // outright ("unexpected argument '-C' found") and has no `-s`, so this path never
    // worked against the real CLI while the fakes were happy with it. The working
    // directory comes from the spawn (`superviseWorker` sets cwd), making `-C` redundant
    // anyway, and the sandbox is expressed as a config override -- verified honoured, the
    // run header reports the mode it was given.
    buildResumeArgv(workDir: string, sessionId: string, feedback: string): string[] {
      void workDir; // the supervisor spawns in the worktree; `exec resume` takes no -C
      const argv = [
        bin,
        'exec',
        'resume',
        sessionId,
        feedback,
        '-c',
        'sandbox_mode=workspace-write',
        '--skip-git-repo-check',
        '--json',
      ];
      if (model !== undefined) argv.push('-m', model);
      if (effort !== undefined) argv.push('-c', `model_reasoning_effort=${effort}`);
      return argv;
    },
  };
}

// The claude CLI as a headless executor. It gets Read/Edit/Write/Bash and normal
// edit-acceptance permissions: reads outside the worktree are denied. `--allowedTools`
// names what it may actually *run*: the task's own verify commands, plus the narrow git
// allowlist every task needs (see GIT_GRANTS).
//
// Bash is unconditional, which it was not before: a task used to get Bash only when it
// declared a gate. That stopped working the moment the contract began requiring one commit
// per functional unit -- a task with no verify command still has to commit. Measured
// (PROBE-1, 2026-08-21): with Bash present but git absent from the allow list, a real run
// wrote its file and was then refused, verbatim -- "This Bash command contains multiple
// operations. The following parts require approval: git add unit-a.txt, git commit -m ..."
// -- and stalled asking a human who, headless, was not there.
//
// Be precise about what that grant is, because two real runs measured it and the first
// reading was wrong. `acceptEdits` auto-approves **read-only** Bash on its own -- which is
// why an earlier run executed `git diff` unprompted, not because the allow list was ignored.
// Anything that is not read-only must match `--allowedTools`: a later run was blocked
// reaching for `npm run typecheck` and stalled asking a human who, headless, was not there.
// So the grant does confine what the executor can *do*, while reading is open. The bound on
// reading is the worktree cwd plus the stripped environment (`io/env.ts`); codex's
// `workspace-write` sandbox is still the tighter of the two.
//
// `--strict-mcp-config` is deliberate: without it a headless run inherits every MCP
// server configured for the user's own session (observed: a personal vault and a sync
// server), which hands a sandboxed executor tools far outside its task.
//
// Router still verifies independently afterward. Plan-auth comes from the user's Claude
// session; ROUTER_CLAUDE_BIN overrides the binary in tests. Cost comes from the stream's
// total_cost_usd.
export function claudeLauncher(worker: Pick<WorkerPolicy, 'model' | 'effort'>): WorkerLauncher {
  const bin = process.env.ROUTER_CLAUDE_BIN ?? 'claude';
  const model = worker.model;
  const effort = worker.effort;
  return {
    kind: 'claude',
    ...(model !== undefined ? { model } : {}),
    parseLog: parseClaudeLog,
    buildArgv(ctx: WorkerContext): string[] {
      const verifyCommands = gateCommands(ctx.task);
      const argv = [
        bin,
        '-p',
        buildPrompt(ctx),
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--strict-mcp-config', // no MCP servers: do not inherit the user's own
        '--tools',
        'Read,Edit,Write,Bash',
        '--add-dir',
        ctx.workDir,
      ];
      argv.push('--allowedTools', ...bashGrants(verifyCommands));
      if (model !== undefined) argv.push('--model', model);
      if (effort !== undefined) argv.push('--effort', effort);
      return argv;
    },
    // `claude --resume <session-id> -p <feedback>` continues that session with its
    // context retained. The session-id continuity guard in `router resume` verifies
    // it re-attached.
    buildResumeArgv(workDir: string, sessionId: string, feedback: string, task?: TaskYaml): string[] {
      const verifyCommands = task === undefined ? [] : gateCommands(task);
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
        '--strict-mcp-config', // no MCP servers: do not inherit the user's own
        '--tools',
        'Read,Edit,Write,Bash',
        '--add-dir',
        workDir,
      ];
      argv.push('--allowedTools', ...bashGrants(verifyCommands));
      if (model !== undefined) argv.push('--model', model);
      if (effort !== undefined) argv.push('--effort', effort);
      return argv;
    },
  };
}

/** The gate commands a task declares, as single strings. */
function gateCommands(task: TaskYaml): string[] {
  return (task.verify ?? []).filter((command) => command.length > 0).map((command) => command.join(' '));
}

/**
 * The git subcommands every executor gets, because the task contract requires one commit per
 * functional unit. Deliberately a subcommand allowlist and NOT `Bash(git:*)`: the contract's
 * Must NOT forbids the executor rewriting history or moving between branches, so `checkout`,
 * `reset`, `rebase`, `branch -d` and `push` stay unreachable.
 *
 * A subcommand prefix is enough to be safe here because the permission system decomposes a
 * compound command and checks each part -- measured verbatim in PROBE-1: "This Bash command
 * contains multiple operations. The following parts require approval: ...". So
 * `git add x && git commit -m y` is approved by these two grants, while
 * `git commit -m y && git checkout main` still stops on the checkout.
 */
const GIT_GRANTS: readonly string[] = [
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git rev-parse:*)',
];

/**
 * Bash pre-approvals: the task's gate (exact command plus its program+subcommand prefix),
 * then GIT_GRANTS.
 *
 * Measured why the gate prefix is needed: with only the exact string, a real sonnet run read
 * files freely (`acceptEdits` auto-approves read-only Bash) but was blocked the moment it
 * reached for `npm run typecheck` -- a sub-step of its own gate. Headless there is nobody to
 * approve, so it stalled asking, shipped no tests, and emitted no delivery header. The prefix
 * keeps the grant inside the project's own script runner while letting the executor iterate
 * normally.
 */
function bashGrants(verifyCommands: readonly string[]): string[] {
  const grants = new Set<string>();
  for (const command of verifyCommands) {
    grants.add(`Bash(${command})`);
    const prefix = command.split(' ').slice(0, 2).join(' ');
    if (prefix !== '' && prefix !== command) grants.add(`Bash(${prefix}:*)`);
  }
  for (const grant of GIT_GRANTS) grants.add(grant);
  return [...grants];
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
  // `plan_revision` is the version of the frozen plan, NOT the plan's identity: `plan_id`
  // groups a plan's tasks, `plan_revision` says which revision of it this contract was
  // written against, so a stale contract can be told apart from a current one. Reporting
  // the id here made every delivery report echo the group name and made the cross-check
  // compare a field against itself.
  const planRevision = ctx.task.plan_revision ?? 'none';
  const taskContext =
    ctx.taskContext == null
      ? ''
      : `--- TASK CONTEXT (navigation, NOT the source of truth) ---\n` +
        ctx.taskContext.text +
        (ctx.taskContext.text.endsWith('\n') ? '' : '\n') +
        `--- end task context ---\n` +
        `This summary was written from an earlier reading of the repository. The contract above\n` +
        `outranks it, and the code outranks them both. Before you change anything: locate the files and\n` +
        `symbols it points at, read the bounded slices you actually need, and confirm the assumptions\n` +
        `you are about to rely on. If the code contradicts this summary or the contract, do NOT adapt\n` +
        `the plan yourself -- report CONTRACT_CONFLICT with the evidence you found.\n\n`;
  return (
    `${ctx.contractMdText.trim()}\n\n` +
    taskContext +
    `You own this task start to finish: read the code you are about to change, decide your own\n` +
    `internal steps, implement it, write tests for what you changed, ${gateStep}, then check your\n` +
    `own diff against the scope below before finishing.\n\n` +
    `COMMIT AS YOU GO. One commit per functional unit, each with its own tests -- a unit being\n` +
    `something a human can review as one thing. The unit is not the smallest possible change and\n` +
    `not the whole task: adding a storage access method is file IO, then the storage format, then\n` +
    `the storage architecture, one commit each; splitting the file IO alone into ten commits is\n` +
    `as wrong as squashing all three into one. Do NOT wait for green to commit -- the gate runs\n` +
    `once at the end, so an intermediate commit that does not build yet is expected and fine.\n` +
    `You must leave NOTHING uncommitted: an uncommitted file is invisible to every gate, so it\n` +
    `fails the run rather than slipping through. Use only \`git add\` and \`git commit\`; you have\n` +
    `no permission to checkout, reset, rebase, or move branches, and must not try.\n\n` +
    `Constraints:\n` +
    `- Change ONLY files matching: ${scope}\n` +
    `- Do not touch tests except to make them pass legitimately.\n` +
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
