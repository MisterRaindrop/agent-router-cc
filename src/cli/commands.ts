// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { ROUTER_DIR, VERSION } from '../domain/constants.ts';
import type { RunResult, RunStatus } from '../domain/types.ts';
import { systemClock, type Clock } from '../io/clock.ts';
import { EXECUTOR_SANDBOX_ENV } from '../io/env.ts';
import { writeJsonAtomic } from '../io/atomicWrite.ts';
import { branchExists, currentBranch, deleteBranchAt, mergeAbort, mergeNoFF, resolveCommit } from '../io/git.ts';
import { findRouterDir, routerPaths, runId as fmtRunId, taskBranch, type RouterPaths } from '../io/paths.ts';
import * as store from '../io/store.ts';
import { dispatchTask, dispatchTasks, resumeTask } from '../app/dispatch.ts';
import { gateYamlPath, loadGateConfig } from '../app/gateConfig.ts';
import { runQueueGate } from '../app/gateQueue.ts';
import { pinnedHead } from '../app/verifiedHead.ts';
import { acquireLock, readLock } from '../io/lock.ts';
import { loadModelConfig, modelsYamlPath } from '../app/modelConfig.ts';
import { recordOrchestratorUsage } from '../app/orchestratorUsage.ts';
import { readRunStatus } from '../app/runStatus.ts';
import { isDegraded, loadCodeIntelConfig, runIndex, runQuery } from '../app/symbolIndex.ts';
import { parseSymbols } from '../io/treeSitter.ts';
import { buildRoutingReport, buildUsageReport, explainSavingsText, renderRouting, renderUsage } from '../app/usageReport.ts';
import { STRONG_BASELINE_MODEL } from '../core/pricing.ts';
import { planStatusLine } from '../core/statuslineSetup.ts';
import {
  ActivityAlreadyExistsError,
  HeartbeatStartupError,
  SUPERVISE_INTERNAL_ERROR_CODE,
  superviseCommand,
} from '../app/supervise.ts';
import { CliError, emit, err } from './output.ts';
import { flagBool, flagStr, type ParsedArgs } from './args.ts';

// The lean CLI: a synchronous task dispatcher. No state machine, no policy, no init
// ceremony. Verbs: init (optional pre-scaffold), new (author a task skeleton),
// dispatch (run one task to a verified diff), land (merge a PASSED dispatch), result.

export interface Ctx {
  args: ParsedArgs;
  cwd: string;
  json: boolean;
}
type Handler = (ctx: Ctx) => number | Promise<number>;

interface Deps {
  paths: RouterPaths;
  clock: Clock;
}

// Auto-scaffold: no `init` needed. If no .router is found up-tree, create one at the
// cwd; `.router/` is fully gitignored so router state never pollutes the repo.
//
// Except from inside an executor, where every path through here is refused. This is the
// enforcement for "the executor must not write real orchestration state", and it has to live
// in the CLI because nothing else can reach it: the guard-router-state hook inspects
// Write/Edit file paths, so it sees neither a Bash invocation nor codex at all.
//
// The reachable case, reproduced before this check existed: give an executor a task that
// changes `router new`, and it runs `router new --id smoke` to try its own work. Under the
// branch model its cwd IS the repo root, so `.router/` resolves to the real state directory
// and `.router/tasks/smoke/` gets written. `.router/.gitignore` is `*`, so no gate ever sees
// it. Refusing the whole verb -- read and write -- is deliberate: the CLI is the
// orchestrator's instrument, the executor works through files, git and its own gate, and one
// rule cannot be half-bypassed the way an allowlist of safe verbs could be.
function depsFor(ctx: Ctx, readOnly = false): Deps {
  // Read-only verbs are allowed through. The refusal used to cover every verb, which was
  // over-broad: `router list` and `router result` change nothing, and blocking them told an
  // executor "you may not look at the run you are part of" for no safety gain. What the sandbox
  // is for is WRITES -- and it never really stopped those anyway (a nested CLI is only one way to
  // write a file), which is why the real enforcement is now detection in app/stateGuard.ts.
  if (!readOnly && (process.env[EXECUTOR_SANDBOX_ENV] ?? '') !== '') {
    throw new CliError(
      `refusing to WRITE router state from inside an executor (${EXECUTOR_SANDBOX_ENV} is set). ` +
        `Orchestration state belongs to the dispatching session; work through files, git and your gate. ` +
        `Read-only verbs (list, result, models, doctor) are available.`,
      2,
    );
  }
  const explicit = flagStr(ctx.args.flags, 'router-dir');
  const found = explicit ?? findRouterDir(ctx.cwd);
  const rd = found ?? join(ctx.cwd, ROUTER_DIR);
  const paths = routerPaths(rd);
  // Not worktreesDir: nothing creates a per-task worktree any more, and scaffolding an empty
  // directory that will stay empty is the kind of leftover that reads as "there are live runs
  // in here". The deprecated path creates its own if it is ever re-enabled.
  //
  // A read-only verb scaffolds nothing: it would be a write, and there is nothing to read in a
  // tree that had to be created first.
  if (!readOnly) {
    for (const d of [paths.root, paths.tasksDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
    const gi = join(paths.root, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '*\n');
  }
  return { paths, clock: systemClock };
}

function requireId(ctx: Ctx): string {
  const id = flagStr(ctx.args.flags, 'id') ?? ctx.args.positionals[0];
  if (id === undefined || id === '') throw new CliError('missing task id', 2);
  return id;
}

function requireIds(ctx: Ctx): string[] {
  const flagId = flagStr(ctx.args.flags, 'id');
  const ids = [...(flagId !== undefined ? [flagId] : []), ...ctx.args.positionals];
  if (ids.length === 0 || ids.some((id) => id === '')) throw new CliError('missing task id', 2);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new CliError(`duplicate task id: ${id}`, 2);
    seen.add(id);
  }
  return ids;
}

const RUN = fmtRunId(1); // one synchronous attempt per task

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function taskTemplate(id: string, title: string): string {
  return dump(
    {
      schema_version: 1,
      id,
      title,
      max_wall_minutes: 30,
      allowed_globs: ['src/**'],
      forbidden_globs: [],
      max_changed_lines: 400,
      verify: [] as string[][], // e.g. [["npm","test"]]; empty = diff/scope/secret only
    },
    { lineWidth: 120 },
  );
}
// The seven headings are the dispatchability test: a package an executor can own end to
// end has all seven, and one that cannot state its invariants, its blast radius, or when to
// stop is still a decision the orchestrator owes the user, not a task to hand off. They are
// also what the reviewer judges drift against -- "it changed something it was told not to"
// is only checkable when the contract said so.
// The test-hygiene block is boilerplate on purpose: these are the mistakes BOTH cheap
// and strong models make (measured, not guessed) -- a fixed global resource name that
// collides when a test runner repeats the test, state left behind when a test aborts
// mid-way, and a test script created without its executable bit. Keep this block short:
// a longer contract gets skimmed, which defeats the point.
const contractTemplate = (id: string, title: string): string =>
  `# ${title}\n\ntask: ${id}\n\n## Goal\n\n_What to accomplish._\n\n` +
  `## Invariants (must not change)\n\n_What this task may NOT alter, however convenient._\n\n` +
  `## Frozen interfaces / dependencies\n\n` +
  `_The already-agreed signatures and files this builds on; the tasks it depends on._\n\n` +
  `## Definition of Done\n\n- [ ] ...\n- [ ] Carries tests for the code it changes.\n\n` +
  `## Blast radius (worst case if this is wrong)\n\n_What breaks, and how visibly._\n\n` +
  `## Stop conditions (stop and report instead of improvising)\n\n` +
  `_Report \`CONTRACT_CONFLICT\` rather than working around any of these._\n\n` +
  `\n## Test hygiene (applies whenever this task adds or changes tests)\n\n` +
  `- [ ] Every shared or globally-scoped thing the test creates (server-wide entities,\n` +
  `      fixed table/user/file names, paths outside a per-run temp dir) is namespaced per\n` +
  `      run, so the same test running twice -- in parallel or repeated -- cannot collide.\n` +
  `- [ ] The test cleans up what it created **including on the failure path**: a test that\n` +
  `      aborts at its first failed assertion must not leave state that breaks later runs.\n` +
  `- [ ] A test script meant to be executed carries the executable bit (match the mode of\n` +
  `      the other test scripts in that directory).\n`;

// -- verbs ------------------------------------------------------------------

const init: Handler = (ctx) => {
  const { paths } = depsFor(ctx); // depsFor already scaffolds + gitignores
  emit(ctx.json, { ok: true, root: paths.root }, () =>
    `ready at ${paths.root} (optional; router auto-creates this on first use)`,
  );
  return 0;
};

const newTask: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const title = flagStr(ctx.args.flags, 'title') ?? id;
  mkdirSync(paths.taskDir(id), { recursive: true });
  if (!existsSync(paths.taskYaml(id))) writeFileSync(paths.taskYaml(id), taskTemplate(id, title));
  if (!existsSync(paths.contractMd(id))) writeFileSync(paths.contractMd(id), contractTemplate(id, title));
  emit(ctx.json, { ok: true, id, task_yaml: paths.taskYaml(id) }, () =>
    `created ${id} - edit ${paths.taskYaml(id)} (allowed_globs, verify), then \`router dispatch ${id}\``,
  );
  return 0;
};

const dispatch: Handler = async (ctx) => {
  const deps = depsFor(ctx);
  const ids = requireIds(ctx);
  // Rejected rather than ignored: silently accepting a flag that no longer does anything is
  // how a caller ends up believing four executors ran when one did.
  if (flagStr(ctx.args.flags, 'max-parallel') !== undefined) {
    throw new CliError('--max-parallel was removed; router dispatches one task at a time', 2);
  }
  if (ids.length === 1) {
    const id = ids[0]!;
    const result = await dispatchTask(deps, id);
    const v = result.verifier?.result ?? 'FAILED';
    emit(ctx.json, dispatchOutput(id, result), () => dispatchLine(id, result));
    return v === 'PASSED' ? 0 : 1;
  }

  const results = await dispatchTasks(deps, ids);
  const passed = results.filter((result) => result.verifier?.result === 'PASSED').length;
  emit(
    ctx.json,
    {
      ok: passed === results.length,
      results: results.map((result, index) => dispatchOutput(ids[index]!, result, false)),
    },
    () => [...results.map((result, index) => dispatchLine(ids[index]!, result)), `${passed}/${results.length} PASSED`].join('\n'),
  );
  return passed === results.length ? 0 : 1;
};

function dispatchOutput(id: string, result: Awaited<ReturnType<typeof dispatchTask>>, includeOk = true): Record<string, unknown> {
  const v = result.verifier?.result ?? 'FAILED';
  return {
    ...(includeOk ? { ok: v === 'PASSED' } : {}),
    id,
    executor: result.worker.kind,
    model: result.worker.model ?? null,
    // `null` when the verifier never ran (a contract conflict, a timeout, a stalled run) --
    // distinct from a gate that ran and failed. `router result` already says `n/a` here, and
    // reporting a machine-readable "FAILED" for something never attempted is the kind of
    // dressed-up gap the assurance rules forbid. `ok` is unaffected: it needs PASSED.
    verifier: result.verifier?.result ?? null,
    exit_class: result.exit_class,
    conflict: result.conflict ?? false,
    risk: result.risk ?? null,
    commands_run: result.commands_run ?? null,
    tokens: result.tokens ?? null,
    cost_usd: result.cost_usd ?? null,
    executor_switches: result.executor_switches ?? 0,
    model_mismatch: result.model_mismatch ?? false,
    delivery: result.delivery?.path ?? null,
    delivery_header: result.delivery?.header_error ?? (result.delivery?.header ? 'ok' : 'missing'),
    uncommitted_changes: result.uncommitted_changes ?? false,
    branch: result.branch ?? null,
    rescue_sha: result.rescue_sha ?? null,
    discarded_shas: result.discarded_shas ?? [],
    closeout: result.closeout ?? null,
    dirty_submodules: result.dirty_submodules ?? [],
    state_tampering: result.state_tampering ?? [],
  };
}

function dispatchLine(id: string, result: Awaited<ReturnType<typeof dispatchTask>>): string {
  const v = result.verifier?.result ?? 'FAILED';
  const who = `${result.worker.kind}${result.worker.model ? `/${result.worker.model}` : ''}`;
  const sw = result.executor_switches ? `, switched ${result.executor_switches}x` : '';
  // Where the user is left standing. Router never switches back and never merges, so a report
  // that omits this leaves them on a branch they did not check out and were not told about.
  const where = result.branch ? `\nYou are now on branch ${result.branch}.` : '';
  const rescued = result.rescue_sha
    ? `\nYour uncommitted work was committed first as ${result.rescue_sha.slice(0, 12)} ` +
      `(undo with: git reset --soft ${result.rescue_sha.slice(0, 12)}~1).`
    : '';
  const salvaged =
    result.discarded_shas && result.discarded_shas.length > 0
      ? `\nSalvaged before an executor switch, unreachable but recoverable: ` +
        `${result.discarded_shas.map((sha) => sha.slice(0, 12)).join(', ')}`
      : '';
  const submodules =
    result.dirty_submodules && result.dirty_submodules.length > 0
      ? `\nNOTE: ${result.dirty_submodules.length} submodule(s) have uncommitted content. That lives in ` +
        `another repository, so it was neither rescued nor reset.`
      : '';
  const tampered =
    result.state_tampering && result.state_tampering.length > 0
      ? `\nSTATE TAMPERING: the executor changed router's own state under .router/, which no gate ` +
        `can see because it is gitignored:\n  ${result.state_tampering.join('\n  ')}`
      : '';
  const closeout =
    result.closeout && !result.closeout.ok
      ? `\nCLOSING INVARIANT FAILED: ${result.closeout.reason}` +
        (result.closeout.files.length > 0 ? `\n  ${result.closeout.files.join('\n  ')}` : '')
      : '';
  if (result.conflict === true || result.exit_class === 'contract_conflict') {
    const report = result.delivery?.path ?? `.router/tasks/${id}/DELIVERY.md`;
    return `${id}: CONTRACT CONFLICT (executor ${who}${sw}); nothing verified; the plan needs revising; report: ${report}${where}${rescued}`;
  }
  const next = v === 'PASSED' ? `review the diff, then \`router land ${id}\`` : `see \`router result ${id}\``;
  const warn = result.model_mismatch
    ? `\nWARNING: ${result.worker.kind} rejected model '${result.worker.model ?? '?'}' -- your model config may be stale ` +
      `(provider updated its lineup, or your plan lacks this tier). Edit .router/models.yaml; nothing was changed automatically.`
    : '';
  const report = result.delivery
    ? ` report: ${result.delivery.path}${result.delivery.header_error ? ` [delivery_header: ${result.delivery.header_error}]` : ''}`
    : '';
  // An unfinished run leaves work uncommitted in the user's own checkout now, not in a
  // worktree they would never have looked in.
  const recoverable = result.uncommitted_changes
    ? `\nNOTE: this run left uncommitted changes in your checkout -- inspect with: git status`
    : '';
  const raisedRisk =
    result.risk_raised_by && result.risk_raised_by.length > 0
      ? `\nRISK RAISED to ${result.risk}: ${result.risk_raised_by.join(', ')}`
      : '';
  return (
    `${id}: ${v} (executor ${who}${sw}); ${next}${report}` +
    `${tampered}${closeout}${recoverable}${warn}${raisedRisk}${where}${rescued}${salvaged}${submodules}`
  );
}

// Resume the prior dispatch's executor session with feedback (context retained) instead
// of a cold re-dispatch. Fail-loud: if the executor reports a different session id, the
// resume did not re-attach -- nothing is committed and this exits non-zero.
const resume: Handler = async (ctx) => {
  const deps = depsFor(ctx);
  const id = requireId(ctx);
  const feedback = flagStr(ctx.args.flags, 'feedback') ?? '';
  if (feedback === '') throw new CliError('resume needs --feedback "<what to fix>"', 2);
  const result = await resumeTask(deps, id, feedback);
  const mism = result.resume_session_mismatch === true;
  // `null` when the verifier never ran, exactly as `dispatch` already reports it. A session
  // mismatch or a failed closeout skips verification entirely, and collapsing "never attempted"
  // into a machine-readable "FAILED" is the dressed-up gap the assurance rules forbid.
  // dispatchOutput was fixed for this; resume was missed.
  const verifierResult = result.verifier?.result ?? null;
  emit(
    ctx.json,
    {
      ok: !mism && verifierResult === 'PASSED',
      id,
      resumed: true,
      session_mismatch: mism,
      session_id: result.session_id ?? null,
      verifier: verifierResult,
      exit_class: result.exit_class,
    },
    () => {
      if (mism) {
        const reported =
          result.resume_reported_session == null
            ? 'reported no session id at all'
            : `reported a different session id (${result.resume_reported_session})`;
        // Not "nothing committed" -- that was false. A resumed executor writes and commits to the
        // task branch before we ever learn which session it was; what the mismatch stops is
        // VERIFICATION. Telling the user nothing was committed sent them looking at a clean tree
        // while the branch had moved.
        return (
          `${id}: RESUME DID NOT RE-ATTACH -- the executor ${reported}; NOT verified. ` +
          `Anything it committed is on ${result.branch ?? `router/${id}`} and has cleared no gate: ` +
          `review or reset that branch, then re-dispatch, or check the resume invocation.`
        );
      }
      const next =
        verifierResult === 'PASSED'
          ? `review the diff, then \`router land ${id}\``
          : `see \`router result ${id}\``;
      // "not verified" reads differently from "FAILED", and the difference is the whole point.
      return `${id}: resumed -> ${verifierResult ?? 'not verified'} (${result.exit_class}); ${next}`;
    },
  );
  return !mism && verifierResult === 'PASSED' ? 0 : 1;
};

const land: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const ids = requireIds(ctx);
  const landed: { id: string; merged: string; merge_commit: string }[] = [];
  for (const id of ids) {
    const result = store.readResult(paths, id);
    const prior = landed.length > 0 ? `; already landed: ${landed.map((l) => l.id).join(', ')}` : '';
    if (result === null) throw new CliError(`${id}: no dispatch result to land (run \`router dispatch ${id}\` first)${prior}`, 1);
    if (result.conflict === true || result.exit_class === 'contract_conflict') {
      const report = result.delivery?.path ?? paths.delivery(id);
      throw new CliError(`${id}: contract conflict; refusing to land -- the plan needs revising; report: ${report}${prior}`, 1);
    }
    if (result.verifier?.result !== 'PASSED') throw new CliError(`${id}: last dispatch was not PASSED${prior}`, 1);
    const branch = result.branch ?? taskBranch(id);
    // What the verdict actually covers -- a commit, not a branch name. Merging the name would
    // resolve it a second time inside git, and the reviewer used exactly that gap to move the
    // ref between the check and the merge and land an unverified commit.
    const pin = pinnedHead(paths.repoRoot, branch, result);
    if (!pin.ok) {
      throw new CliError(
        `${id}: ${pin.reason}; merging would land work no verifier judged. Re-run ` +
          `\`router go\` (or \`router dispatch ${id}\`) to verify the branch as it stands${prior}`,
        1,
      );
    }
    // Dispatch now leaves the user standing ON the task branch, so `land` has to say so rather
    // than attempt to merge a branch into itself (and then fail to delete the branch it is on).
    // Checking out the merge target is the user's decision: merging is irreversible, and
    // choosing what to merge into is the whole point of not doing it automatically.
    if (currentBranch(paths.repoRoot) === branch) {
      throw new CliError(
        `${id}: you are on ${branch}, the branch to be landed. Check out the branch you want to ` +
          `merge INTO first, then re-run \`router land ${id}\`${prior}`,
        1,
      );
    }
    try {
      mergeNoFF(paths.repoRoot, pin.sha, `Merge branch '${branch}'`);
    } catch (e) {
      mergeAbort(paths.repoRoot);
      throw new CliError(`merge failed (aborted, tree restored): ${(e as Error).message}${prior}`, 1);
    }
    // The run branch is deleted right after the merge, so record the merge commit: it is
    // the only durable handle on what this task changed (`git show <sha>`). Without it a
    // later review or post-mortem has no way back to the task's diff.
    const mergeCommit = resolveCommit(paths.repoRoot, 'HEAD');
    // Compare-and-swap, so a branch that gained a commit while we were merging keeps it. A plain
    // `branch -D` deletes whatever the name means NOW, taking the only reference to that commit
    // with it -- silently discarding work rather than merely failing to merge it.
    if (!deleteBranchAt(paths.repoRoot, branch, pin.sha)) {
      throw new CliError(
        `${id}: merged ${pin.sha.slice(0, 12)} as ${mergeCommit.slice(0, 12)}, but ${branch} ` +
          `moved while we did; it is kept, not deleted -- inspect it before removing it${prior}`,
        1,
      );
    }
    store.writeResult(paths, id, { ...result, merge_commit: mergeCommit });
    landed.push({ id, merged: branch, merge_commit: mergeCommit });
  }
  // Report once, after the loop: a batch has to leave stdout as ONE json document, so
  // emitting per merge is not an option. A single id keeps the original object shape.
  emit(ctx.json, landed.length === 1 ? { ok: true, ...landed[0]! } : { ok: true, landed }, () =>
    landed
      .map((l) => `${l.id} landed (${l.merged} -> ${l.merge_commit.slice(0, 12)}); diff: git show ${l.merge_commit.slice(0, 12)}`)
      .join('\n'),
  );
  return 0;
};

// Verify dispatched commits in the project's REAL environment. That environment exists once
// -- one Docker container bound to a fixed host path, one build directory, one database -- so
// the queue is serial by nature and borrows the user's own checkout under an exclusive lock.
// A run worktree cannot substitute: it is a different source path with none of those caches.
const gate: Handler = async (ctx) => {
  const deps = depsFor(ctx);
  const cfg = loadGateConfig(deps.paths);

  if (flagBool(ctx.args.flags, 'status')) {
    const holder = readLock(deps.paths.gateLock());
    emit(ctx.json, { ok: true, mode: cfg.mode, integration_branch: cfg.integration_branch ?? null, holder }, () =>
      holder === null
        ? `gate mode ${cfg.mode}; no verification in progress`
        : `gate mode ${cfg.mode}; BUSY -- pid ${holder.pid} holds the checkout (last beat ${new Date(holder.beatAtMs).toISOString()})`,
    );
    return 0;
  }

  if (cfg.mode !== 'queue') {
    throw new CliError(
      `gate mode is "${cfg.mode}": this project verifies inside the run worktree via each task's ` +
        `\`verify\`, so there is nothing to queue. Set mode: queue in ${gateYamlPath(deps.paths)} ` +
        `for a project whose real gate needs Docker, a single build directory, or live services.`,
      2,
    );
  }

  const ids = requireIds(ctx);
  const done: { id: string; gate: Awaited<ReturnType<typeof runQueueGate>> }[] = [];
  // Sequential on purpose, and it stops at the first failure: a failure means the plan or the
  // executor needs attention, and `checkout_dirty`/`lock_unavailable` would stop the rest anyway.
  for (const id of ids) {
    const g = await runQueueGate(deps, id);
    done.push({ id, gate: g });
    if (!g.ok) break;
  }
  const allOk = done.every((d) => d.gate.ok) && done.length === ids.length;
  emit(ctx.json, { ok: allOk, results: done }, () =>
    done
      .map(({ id, gate: g }) =>
        g.ok
          ? `${id}: VERIFIED (${g.level} gate) on ${g.integration_branch} -> ${(g.head_sha ?? '').slice(0, 12)}; evidence: ${g.log}`
          : `${id}: NOT VERIFIED (${g.reason})${
              g.dirty && g.dirty.length > 0 ? `; uncommitted: ${g.dirty.join(', ')}` : ''
            }${g.log ? `; evidence: ${g.log}` : ''}${g.reset_log ? `; reset output: ${g.reset_log}` : ''}`,
      )
      .concat(allOk ? [] : ['stopped at the first failure; the remaining tasks were not attempted'])
      .join('\n'),
  );
  return allOk ? 0 : 1;
};

const result: Handler = (ctx) => {
  const { paths } = depsFor(ctx, true /* read-only */);
  const id = requireId(ctx);
  // `--run` is accepted and ignored: the run dimension was folded away, and a message that
  // names `run-001` sends the reader looking for a path that no longer exists.
  const res = store.readResult(paths, id);
  if (res === null) throw new CliError(`no result for ${id} (dispatch it first)`, 3);
  let tail = '';
  try {
    tail = readFileSync(paths.workerLog(id), 'utf8').split('\n').slice(-50).join('\n');
  } catch {
    /* no log */
  }
  emit(ctx.json, { ok: true, result: res }, () => {
    const checks = (res.verifier?.checks ?? [])
      .map((c) => `  ${c.ok ? 'ok' : 'x'} ${c.id}${c.detail ? ` - ${c.detail}` : ''}`)
      .join('\n');
    return `: exit=${res.exit_class} verifier=${res.verifier?.result ?? 'n/a'}\n${checks}\n--- log tail ---\n${tail}`;
  });
  return 0;
};

// The status column answers "where is this task right now", so a run still in flight must
// read as its live phase: result.json only lands when the run is over, status.json is
// written throughout. Once result.json exists it wins -- it is the verified outcome, and
// the last status.json of a finished run says nothing more than its terminal state does.
function statusLabel(res: RunResult | null, live: RunStatus | null, nowMs: number): string {
  if (res !== null) return res.verifier?.result ?? res.exit_class;
  if (live === null) return 'none';
  if (live.terminal_state !== undefined) return live.terminal_state;
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(live.started_at)) / 60_000));
  return `${live.phase} ${minutes}m`;
}

// List authored tasks with their last dispatch status and whether a worktree is
// still on disk (read-only; helps you see leftovers before cleaning them).
const list: Handler = (ctx) => {
  const { paths, clock } = depsFor(ctx, true /* read-only */);
  const nowMs = Date.parse(clock.nowIso());
  const ids = existsSync(paths.tasksDir)
    ? readdirSync(paths.tasksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  const rows = ids.map((id) => {
    let title = '';
    try {
      title = ((load(readFileSync(paths.taskYaml(id), 'utf8')) as { title?: string } | null)?.title) ?? '';
    } catch {
      /* missing/invalid task.yaml */
    }
    const res = store.readResult(paths, id);
    const live = readRunStatus(paths.runStatus(id));
    const status = statusLabel(res, live, nowMs);
    // Was "is there a worktree on disk". There are no per-task worktrees any more, so the
    // question that matters is whether the task's branch is still around to review or merge.
    const branch = res?.branch ?? taskBranch(id);
    const branchLive = branchExists(paths.repoRoot, branch);
    const risk = res?.risk ?? '-';
    const report = res?.delivery ? 'yes' : '-';
    return { id, title, status, branch: branchLive ? branch : null, risk, report, live };
  });
  // A live label ("executor_working 3m") is wider than any terminal one; widen the column
  // to the longest row so the table stays aligned, and keep today's width when none is live.
  const statusWidth = Math.max(10, ...rows.map((r) => r.status.length + 1));
  emit(ctx.json, { ok: true, tasks: rows }, () => {
    if (rows.length === 0) return 'No tasks in .router/tasks.';
    const lines = [
      `Tasks (${rows.length}):`,
      pad('id', 22) + pad('status', statusWidth) + pad('branch', 10) + pad('risk', 10) + pad('report', 10) + 'title',
    ];
    for (const r of rows)
      lines.push(
        pad(r.id, 22) +
          pad(String(r.status), statusWidth) +
          pad(r.branch !== null ? 'present' : '-', 10) +
          pad(r.risk, 10) +
          pad(r.report, 10) +
          r.title,
      );
    const leftover = rows.filter((r) => r.branch !== null).length;
    if (leftover > 0)
      lines.push(`\n${leftover} task branch(es) still present. \`router land <id>\` merges and deletes one; \`git branch -D <branch>\` discards it.`);
    return lines.join('\n');
  });
  return 0;
};

const DOCUMENT_FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BRAINSTORM_STATUSES = new Set(['brainstorming', 'converged', 'rejected']);
const DESIGN_STATUSES = new Set(['design_draft', 'design_approved']);
const PLAN_STATUSES = new Set(['plan_draft', 'plan_approved', 'executing', 'done']);

function documentFrontmatter(text: string): Record<string, unknown> | null {
  const match = DOCUMENT_FRONTMATTER_RE.exec(text);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = load(match[1]!, { schema: JSON_SCHEMA });
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function scalarText(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

// Current plans declare `revision`; `plan_revision` remains readable for artifacts frozen
// by the legacy flow. Malformed or missing frontmatter degrades only this row.
function planRevision(frontmatter: Record<string, unknown> | null): string | null {
  return scalarText(frontmatter?.revision) ?? scalarText(frontmatter?.plan_revision);
}

/** Frontmatter of one document in a plan directory, or null when absent or unreadable. */
function planDocumentFrontmatter(
  paths: RouterPaths,
  planId: string,
  name: string,
): Record<string, unknown> | null {
  try {
    return documentFrontmatter(readFileSync(join(paths.planDir(planId), name), 'utf8'));
  } catch {
    return null;
  }
}

function documentStage(frontmatter: Record<string, unknown> | null, allowed: Set<string>): string | null {
  const status = frontmatter?.status;
  return typeof status === 'string' && allowed.has(status) ? status : null;
}

function highestCritiqueRound(entries: string[]): number | null {
  let max: number | null = null;
  for (const name of entries) {
    const m = /^critique-(\d+)\.md$/.exec(name);
    if (m === null) continue;
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
}

// List plan artifacts under .router/plans -- document stage, PLAN.md's declared revision,
// the highest critique round, decisions, and lock state. This handler deliberately avoids
// depsFor(): browsing plans must never scaffold or otherwise write under .router/.
const plans: Handler = (ctx) => {
  const explicit = flagStr(ctx.args.flags, 'router-dir');
  const paths = routerPaths(explicit ?? findRouterDir(ctx.cwd) ?? join(ctx.cwd, ROUTER_DIR));
  // `.router/plans` has no dedicated field on RouterPaths (only per-plan-id accessors do);
  // this is the one directory we must list to discover which plan ids even exist.
  const plansRoot = join(paths.root, 'plans');
  const ids = existsSync(plansRoot)
    ? readdirSync(plansRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    : [];
  const rows = ids.map((id) => {
    let planFrontmatter: Record<string, unknown> | null = null;
    let hasPlan = true;
    try {
      planFrontmatter = documentFrontmatter(readFileSync(paths.planMd(id), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hasPlan = false;
      /* an unreadable existing PLAN.md still owns the stage, which therefore stays unknown */
    }
    let stage = hasPlan ? documentStage(planFrontmatter, PLAN_STATUSES) : null;
    // The design's own revision, read separately from the plan's. Without this the design stage
    // was unobservable from the tooling: `revision` reads PLAN.md, so a design at revision 3
    // with no plan yet showed as "unknown" -- while /router:design is required to freeze a
    // bumped revision at every approval. Two documents, two revisions, two columns.
    let designRevision: string | null = null;
    let designFrontmatter: Record<string, unknown> | null = null;
    try {
      designFrontmatter = documentFrontmatter(readFileSync(join(paths.planDir(id), 'DESIGN.md'), 'utf8'));
      designRevision = scalarText(designFrontmatter?.revision);
    } catch {
      /* missing or unreadable DESIGN.md -- no design revision to report */
    }
    // Furthest recognized document wins: work plan, else design, else brainstorm. The brainstorm
    // level was missing, so a converged brainstorm -- a finished stage with its direction and
    // rejected alternatives on disk -- reported no stage at all and looked like an empty
    // directory. Same class of blind spot as the design revision being unreadable here.
    //
    // An existing but unparseable work plan still owns the stage (it stays unknown) rather than
    // falling through: a plan on disk means the earlier stages are done, and reporting
    // "brainstorming" over a broken plan would read as regress rather than as damage.
    if (!hasPlan) {
      stage =
        documentStage(designFrontmatter, DESIGN_STATUSES) ??
        documentStage(planDocumentFrontmatter(paths, id, 'BRAINSTORM.md'), BRAINSTORM_STATUSES);
    }
    let critiqueRound: number | null = null;
    try {
      critiqueRound = highestCritiqueRound(readdirSync(paths.planDir(id)));
    } catch {
      /* plan dir unreadable -- treat as no critiques rather than failing the row */
    }
    return {
      id,
      plan_revision: planRevision(planFrontmatter),
      design_revision: designRevision,
      stage,
      critique_round: critiqueRound,
      decisions: existsSync(paths.specDecisions(id)),
      locked: readLock(paths.specLock(id)) !== null,
    };
  });
  emit(ctx.json, { ok: true, plans: rows }, () => {
    if (rows.length === 0) return 'No plans in .router/plans.';
    const width = (header: string, floor: number, values: string[]): number =>
      Math.max(floor, header.length + 1, ...values.map((value) => value.length + 1));
    const idWidth = width('id', 24, rows.map((r) => r.id));
    const revisionWidth = width('revision', 12, rows.map((r) => r.plan_revision ?? 'unknown'));
    const designWidth = width('design', 8, rows.map((r) => r.design_revision ?? '-'));
    const stageWidth = width('stage', 8, rows.map((r) => r.stage ?? '-'));
    const critiqueWidth = width('critique', 10, rows.map((r) => r.critique_round === null ? '-' : String(r.critique_round)));
    const decisionsWidth = width('decisions', 12, rows.map((r) => r.decisions ? 'yes' : '-'));
    const lines = [
      `Plans (${rows.length}):`,
      pad('id', idWidth) + pad('design', designWidth) + pad('revision', revisionWidth) + pad('stage', stageWidth) + pad('critique', critiqueWidth) + pad('decisions', decisionsWidth) + 'locked',
    ];
    for (const r of rows)
      lines.push(
        pad(r.id, idWidth) +
          pad(r.design_revision ?? '-', designWidth) +
          pad(r.plan_revision ?? 'unknown', revisionWidth) +
          pad(r.stage ?? '-', stageWidth) +
          pad(r.critique_round === null ? '-' : String(r.critique_round), critiqueWidth) +
          pad(r.decisions ? 'yes' : '-', decisionsWidth) +
          (r.locked ? 'yes' : '-'),
      );
    return lines.join('\n');
  });
  return 0;
};

// Token/cost usage across recent dispatches, read from .router/metrics.jsonl.
// Provider cost where reported; otherwise a list-price estimate (src/core/pricing.ts).
const usage: Handler = (ctx) => {
  const { paths, clock } = depsFor(ctx);
  const all = flagBool(ctx.args.flags, 'all');
  const report = buildUsageReport(paths, clock.nowIso(), { all });
  if (flagBool(ctx.args.flags, 'routing')) {
    const routing = buildRoutingReport(report.rows);
    emit(ctx.json, { ok: true, routing }, () => renderRouting(routing));
    return 0;
  }
  emit(ctx.json, { ok: true, usage: report }, () => {
    const body = renderUsage(report);
    return flagBool(ctx.args.flags, 'explain-savings') ? `${body}\n\n${explainSavingsText(report.baselineModel)}` : body;
  });
  return 0;
};

const orchestratorUsage: Handler = (ctx) => {
  const planId = flagStr(ctx.args.flags, 'plan');
  if (planId === undefined || planId === '') throw new CliError('orchestrator-usage needs --plan <id>', 2);
  const sinceIso = flagStr(ctx.args.flags, 'since');
  if (sinceIso === undefined || sinceIso === '')
    throw new CliError('orchestrator-usage needs --since <iso>', 2);

  const { paths, clock } = depsFor(ctx);
  const untilIso = flagStr(ctx.args.flags, 'until');
  const transcriptPath = flagStr(ctx.args.flags, 'transcript');
  const projectsDir = flagStr(ctx.args.flags, 'projects-dir');
  const model = flagStr(ctx.args.flags, 'model') ?? STRONG_BASELINE_MODEL;
  // Under the checkout lock, because appending to `metrics.jsonl` while a dispatch is running
  // is now a way to FAIL that dispatch: its state guard watches the file (a forged metrics row
  // falsifies the usage report, so it cannot be ignored), and this command is the one legitimate
  // writer that was not already holding the lock. Recording it a minute later costs nothing;
  // discarding a run that has been going for six is the outcome worth avoiding.
  const usageLock = acquireLock(paths.gateLock(), { waitMs: 0 });
  if ('blocked' in usageLock) {
    throw new CliError(
      `a run is using this checkout (pid ${usageLock.holder?.pid ?? 'unknown'}); ` +
        `record orchestrator usage once it finishes -- the transcript is not going anywhere`,
      1,
    );
  }
  let recorded;
  try {
    recorded = recordOrchestratorUsage(paths, clock, {
      planId,
      sinceIso,
      model,
      ...(untilIso !== undefined ? { untilIso } : {}),
      ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      ...(projectsDir !== undefined ? { projectsDir } : {}),
    });
  } finally {
    usageLock.release();
  }

  if (!recorded.recorded) {
    const message = `orchestrator usage not recorded: ${recorded.reason}; usage will show execution side only`;
    emit(
      ctx.json,
      {
        ok: true,
        recorded: false,
        plan: planId,
        tokens_input: 0,
        tokens_output: 0,
        cost_usd: null,
        reason: recorded.reason,
        message,
      },
      () => message,
    );
    return 0;
  }

  emit(
    ctx.json,
    {
      ok: true,
      recorded: true,
      plan: planId,
      tokens_input: recorded.inputTokens,
      tokens_output: recorded.outputTokens,
      cost_usd: recorded.cost_usd,
    },
    () => {
      const cost = recorded.cost_usd === null ? 'unknown' : `$${recorded.cost_usd.toFixed(6)} est`;
      return (
        `orchestrator usage recorded: plan ${planId}; ` +
        `${recorded.inputTokens} tokens in, ${recorded.outputTokens} tokens out; cost ${cost}`
      );
    },
  );
  return 0;
};

// Wire router's usage-snapshot wrapper into Claude Code's statusLine so the quota
// balancer can read claude-side remaining quota. Chains any existing statusline.
const setupStatusline: Handler = (ctx) => {
  const settingsPath = flagStr(ctx.args.flags, 'settings') ?? join(homedir(), '.claude', 'settings.json');
  const statuslinePath =
    flagStr(ctx.args.flags, 'statusline') ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'statusline', 'router-usage.mjs');
  const dryRun = flagBool(ctx.args.flags, 'dry-run');

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      throw new CliError(`cannot parse ${settingsPath}: ${(e as Error).message}`, 1);
    }
  }
  const rawCurrent = settings.statusLine;
  const current =
    rawCurrent !== null && typeof rawCurrent === 'object' && !Array.isArray(rawCurrent)
      ? (rawCurrent as Record<string, unknown>)
      : undefined;
  const existingCmd = typeof current?.command === 'string' ? current.command : undefined;
  const plan = planStatusLine(existingCmd, statuslinePath, current);

  const changed = plan.action !== 'already-configured';
  if (changed && !dryRun) {
    settings.statusLine = { ...(current ?? {}), ...plan.statusLine };
    writeJsonAtomic(settingsPath, settings);
  }
  const missing = !existsSync(statuslinePath);
  emit(
    ctx.json,
    {
      ok: true,
      action: plan.action,
      settings: settingsPath,
      statusline: statuslinePath,
      command: plan.command,
      chained: plan.inner,
      dry_run: dryRun,
      statusline_exists: !missing,
    },
    () => {
      // The actions are past participles ("chained"), so a bare `would ${action}` reads as
      // "would chained". Map to the infinitive for the dry-run voice.
      const verb: Record<string, string> = {
        created: 'create',
        chained: 'chain',
        repointed: 'repoint',
        updated: 'update',
      };
      const head =
        plan.action === 'already-configured'
          ? `already configured (${settingsPath})`
          : dryRun
            ? `would ${verb[plan.action] ?? plan.action} the statusLine in ${settingsPath}`
            : `${plan.action} statusLine in ${settingsPath}`;
      const chain = plan.inner ? `\n  chained your existing statusline: ${plan.inner}` : '';
      // "repointed" means nothing on its own; say what was wrong, or the user cannot tell
      // whether their setup was broken or is merely being tidied.
      // Same argument for `updated`: the word alone does not say WHAT changed, and the one
      // field it overwrites may be a value the user chose on purpose. Name it and name the
      // old value, so a deliberate 10 is not silently replaced by a 2 the user never sees.

      const why =
        plan.action === 'repointed'
          ? '\n  the previous command pointed at one specific plugin version, which would keep' +
            '\n  running that version after an upgrade; it now resolves the newest at startup'
          : plan.action === 'updated'
            ? `\n  refreshInterval was not set; wrote ${plan.statusLine.refreshInterval}` +
              '\n  a value you set yourself is left alone -- the right one depends on what your' +
              '\n  statusline chains and how large this repository is, which router cannot measure'
            : '';
      const warn = missing ? `\n  WARNING: ${statuslinePath} not found (pass --statusline <path>)` : '';
      const note = changed && !dryRun ? '\n  restart Claude Code (or reload) for it to take effect' : '';
      return `${head}\n  command: ${plan.command}${why}${chain}${warn}${note}`;
    },
  );
  return 0;
};

// Print the resolved model-tier config (bundled default overlaid with any
// .router/models.yaml). Read by the go/spec/review prompts to pick tier models
// and the reviewer chain deterministically.
const models: Handler = (ctx) => {
  const { paths } = depsFor(ctx, true /* read-only */);
  const cfg = loadModelConfig(paths);
  const spec = (s: { model: string; effort?: string }) => `${s.model}${s.effort ? `/${s.effort}` : ''}`;
  emit(ctx.json, { ok: true, models: cfg }, () => {
    const tier = (k: 'codex' | 'claude') => `  ${k}: weak ${spec(cfg[k].weak)}  strong ${spec(cfg[k].strong)}`;
    const review = cfg.review.map((r) => `${r.kind}:${r.model ?? '?'}${r.effort ? `/${r.effort}` : ''}`).join(' -> ');
    const src = existsSync(modelsYamlPath(paths)) ? 'default + .router/models.yaml' : 'default';
    return `model tiers (${src}):\n${tier('codex')}\n${tier('claude')}\n  review: ${review}`;
  });
  return 0;
};

// Code-intelligence symbol index (P1). Out-of-context: `index` prints only a summary
// (the map never enters context); queries return a bounded handful of lines. Every
// unavailable path degrades LOUDLY to a "use rg" message, never a silent empty result.
const symbol: Handler = async (ctx) => {
  const { paths } = depsFor(ctx);
  const cfg = loadCodeIntelConfig(paths);
  const sub = ctx.args.positionals[0] ?? '';
  const limitStr = flagStr(ctx.args.flags, 'limit');
  const limit = limitStr !== undefined ? Number(limitStr) : undefined;

  if (sub === 'index') {
    const dirs = ctx.args.positionals.slice(1);
    const r = await runIndex(paths, cfg, dirs);
    if (isDegraded(r)) {
      emit(ctx.json, { ok: false, degraded: true, reason: r.reason }, () => `code-intel: ${r.reason}`);
      return 0; // graceful: caller falls back to rg
    }
    emit(ctx.json, { ok: true, files: r.files, symbols: r.symbols, reparsed: r.reparsed, cache: r.cache }, () =>
      `indexed ${r.files} files, ${r.symbols} symbols (${r.reparsed} parsed) -> ${r.cache}`,
    );
    return 0;
  }

  if (sub !== 'find' && sub !== 'enclosing' && sub !== 'methods' && sub !== 'callers' && sub !== 'callees') {
    throw new CliError(`usage: router symbol index|find|enclosing|methods|callers|callees`, 2);
  }
  const p1 = ctx.args.positionals[1];
  const p2 = ctx.args.positionals[2];
  const r = await runQuery(paths, cfg, sub, {
    name: p1,
    file: p1,
    line: p2 !== undefined ? Number(p2) : undefined,
    cls: p1,
    limit,
    dirs: [],
  });
  if (isDegraded(r)) {
    emit(ctx.json, { ok: false, degraded: true, reason: r.reason }, () => `code-intel: ${r.reason}`);
    return 0;
  }
  const note = r.reparsed > 0 ? `\n  (refreshed ${r.reparsed} file${r.reparsed === 1 ? '' : 's'})` : '';
  emit(ctx.json, { ok: true, result: r.data, reparsed: r.reparsed }, () => `${r.text}${note}`);
  return 0;
};

// Self-check the code-intelligence layer: config switches, wasm loadable, cache dir.
const doctor: Handler = async (ctx) => {
  const { paths } = depsFor(ctx, true /* read-only */);
  const cfg = loadCodeIntelConfig(paths);
  let wasmOk = false;
  let wasmDetail = '';
  try {
    const parsed = await parseSymbols('class Probe { void m(); };');
    wasmOk = parsed.syms.length > 0;
    wasmDetail = `grammar ${parsed.grammar}`;
  } catch (e) {
    wasmDetail = (e as Error).message;
  }
  const cacheWritable = existsSync(paths.root);
  emit(
    ctx.json,
    {
      ok: wasmOk,
      node: process.version,
      code_intelligence: { enabled: cfg.enabled, index: cfg.index.enabled, lsp: cfg.lsp.enabled },
      scope: cfg.index.scope,
      wasm_ok: wasmOk,
      wasm_detail: wasmDetail,
      symbols_dir: paths.symbolsDir,
      cache_writable: cacheWritable,
    },
    () =>
      `router doctor\n` +
      `  node:          ${process.version}\n` +
      `  code intel:    master=${cfg.enabled} index=${cfg.index.enabled} lsp=${cfg.lsp.enabled}\n` +
      `  index scope:   ${cfg.index.scope.join(', ')}  (maxFiles ${cfg.index.maxFiles})\n` +
      `  tree-sitter:   ${wasmOk ? 'OK' : 'UNAVAILABLE'} (${wasmDetail})\n` +
      `  symbols dir:   ${paths.symbolsDir} ${cacheWritable ? '(writable)' : '(missing)'}\n` +
      (wasmOk ? '' : '  -> symbol index unavailable; spec/review/go will use rg.\n'),
  );
  return wasmOk ? 0 : 1;
};

const superviseHandler: Handler = async (ctx) => {
  const label = flagStr(ctx.args.flags, 'label');
  if (label === undefined || label === '') throw new CliError('supervise requires --label <label>', 2);
  const log = flagStr(ctx.args.flags, 'log');
  if (log === undefined || log === '') throw new CliError('supervise requires --log <file>', 2);
  const argv = ctx.args.passthrough;
  if (argv === undefined) throw new CliError("supervise requires '--' before the command", 2);
  if (argv.length === 0 || argv[0] === '') throw new CliError('supervise requires a command after --', 2);

  const { paths } = depsFor(ctx);
  try {
    const result = await superviseCommand({
      paths,
      label,
      logPath: resolve(ctx.cwd, log),
      argv,
      cwd: ctx.cwd,
      // Match direct foreground execution: the caller chooses the command and its environment.
      env: process.env,
    });
    for (const diagnostic of result.diagnostics) err(`router: supervise cleanup: ${diagnostic}`);
    return result.exitCode;
  } catch (error) {
    if (error instanceof ActivityAlreadyExistsError) throw new CliError(error.message, 2);
    if (error instanceof HeartbeatStartupError) {
      throw new CliError(error.message, SUPERVISE_INTERNAL_ERROR_CODE);
    }
    throw error;
  }
};

export const HANDLERS: Record<string, Handler> = {
  init,
  new: newTask,
  dispatch,
  resume,
  land,
  gate,
  result,
  list,
  plans,
  usage,
  'orchestrator-usage': orchestratorUsage,
  models,
  symbol,
  doctor,
  supervise: superviseHandler,
  'setup-statusline': setupStatusline,
};

export function versionText(): string {
  return VERSION;
}

export function helpText(): string {
  return (
    `router ${VERSION}\n\n` +
    `Usage: router <command> [options]\n\n` +
    `  new <id> [--title T]   author a task skeleton (edit allowed_globs + verify)\n` +
    `  dispatch <id...>       run tasks one at a time on quota-picked executors to verified diffs\n` +
    `  resume <id> --feedback continue the prior executor session with feedback (no cold restart)\n` +
    `  land <id...>           merge PASSED dispatch diffs sequentially\n` +
    `  gate <id...> [--status] verify dispatched commits in the real checkout (serial queue)\n` +
    `  result <id>            show the verifier report + log tail\n` +
    `  list                   list tasks with last status + whether the task branch remains\n` +
    `  plans                  list .router/plans/<id> artifacts: revision, stage, critique round, decisions, lock\n` +
    `  usage [--all] [--routing] token/cost usage, or routing evidence from recent dispatches\n` +
    `  orchestrator-usage --plan <id> --since <iso>  record main-model usage from a Claude transcript\n` +
    `  models                 print the resolved model-tier config (default + .router/models.yaml)\n` +
    `  symbol <sub> [args]    out-of-context symbol index: index [dirs] | find <name> | enclosing <file> <line> | methods <Class> | callers <name> | callees <fn>\n` +
    `  doctor                 self-check the code-intelligence layer (config, wasm, cache)\n` +
    `  supervise --label L --log F -- <argv...>  run a foreground command with visible liveness\n` +
    `  setup-statusline       wire claude-quota reads into Claude Code's statusLine\n` +
    `  init                   optional; router auto-creates .router/ on first use\n\n` +
    `Flags: --json, --all, --routing, --limit, --id, --title, --run, --router-dir, --settings, --statusline, --dry-run\n`
  );
}
