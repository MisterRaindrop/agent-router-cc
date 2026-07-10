// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { ROUTER_DIR, VERSION } from '../domain/constants.ts';
import type { BaselineRecord, TaskState, TaskYaml } from '../domain/types.ts';
import { validateTaskYaml } from '../domain/validate.ts';
import { aggregate, summarizeBaseline } from '../core/stats.ts';
import { hashContract } from '../core/contractHash.ts';
import { isTerminal } from '../core/stateMachine.ts';
import { isRescueAttempt, resolveRescueWorker } from '../core/escalation.ts';
import { classifyRisk } from '../core/risk.ts';
import { planMetricRetention, planRunGc, type TaskGcInput } from '../core/gc.ts';
import { systemClock } from '../io/clock.ts';
import { deleteBranch, mergeAbort, mergeNoFF, resolveCommit, worktreeRemove } from '../io/git.ts';
import { findRouterDir, routerPaths, runBranch, type RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import * as store from '../io/store.ts';
import { createTask, currentState, transition, type TransitionDeps } from '../app/transition.ts';
import { recover } from '../app/recover.ts';
import { rebuildRegistry } from '../app/registry.ts';
import { loadPolicyFromDisk, loadPolicyFromGit } from '../app/policyLoad.ts';
import { makeLauncher } from '../app/codexLauncher.ts';
import { planExecutorOrder } from '../app/routing.ts';
import { runPlan } from '../app/plan.ts';
import { CapExceededError, runWorkerBody, startRun, updateLease } from '../app/worker.ts';
import { loadTask } from '../app/taskLoad.ts';
import { CliError, emit } from './output.ts';
import { flagBool, flagStr, type ParsedArgs } from './args.ts';

export interface Ctx {
  args: ParsedArgs;
  cwd: string;
  json: boolean;
}

type Handler = (ctx: Ctx) => number | Promise<number>;

function depsFor(ctx: Ctx): { deps: TransitionDeps; paths: RouterPaths } {
  const explicit = flagStr(ctx.args.flags, 'router-dir');
  const rd = explicit ?? findRouterDir(ctx.cwd);
  if (rd === undefined || rd === null || !existsSync(rd)) {
    throw new CliError('no .router found - run `router init` first', 3);
  }
  const paths = routerPaths(rd);
  return { deps: { paths, clock: systemClock }, paths };
}

function requireId(ctx: Ctx): string {
  const id = flagStr(ctx.args.flags, 'id') ?? ctx.args.positionals[0];
  if (id === undefined || id === '') throw new CliError('missing task id', 2);
  return id;
}

const POLICY_TEMPLATE = `schema_version: 1
max_concurrent_workers: 1

# Executor CLI. codex and claude are both plan-auth (no API key needed).
worker:
  kind: codex
  stall_minutes: 10

# What a task may change (enforced on the diff, after the run).
scope:
  forbidden_globs: [".router/**", "**/*.lock"]
  test_globs: ["tests/**", "**/*_test.*", "**/*.test.*"]
  max_changed_lines: 400

# Commands the verifier runs. These defaults ALWAYS PASS (node is a requirement, so
# they run anywhere) -- router works out of the box. But then a PASS only means the
# diff applied, stayed in scope, and leaked no secrets. Replace with your project's
# real commands to make PASS also mean "build + tests pass", e.g.:
#   build: [["npm", "run", "build"]]
#   test:  [["npm", "test"]]
verification:
  build:
    - ["node", "-e", "process.exit(0)"]
  test:
    - ["node", "-e", "process.exit(0)"]

# ---- Optional tuning (uncomment; all inert by default) -----------------------
# Fallback chain + budget-aware routing (replaces the single 'worker' above): start
# each run on the executor with quota headroom, fall over on a rate-limit hit.
# workers:
#   - kind: codex
#     budget: { window_minutes: 300, budget_tokens: 4000000, switch_at: 0.9 }
#   - kind: claude
# routing:
#   estimate_tokens_default: 40000
#
# Per-model USD prices (per million tokens). Fill these in and 'router stats' reports
# real spend and savings; budget routing can then compare executors by cost.
# pricing:
#   default: { input_per_mtok: 3, output_per_mtok: 15 }
#
# Recover from failures: retry -> stronger model -> hand back to a human.
# escalation:
#   max_attempts: 2
#   rescue_worker: { kind: claude }
#
# Hard ceilings per task -- refuse a new run once accumulated spend passes these.
# budget_caps: { max_cost_usd: 1.0, max_tokens: 2000000 }
`;

const CONTRACT_TEMPLATE = (id: string, title: string): string =>
  `# ${title}\n\ntask: ${id}\n\n## Goal\n\n_Describe what to accomplish._\n\n## Definition of Done\n\n- [ ] ...\n`;

function taskTemplate(id: string, title: string): string {
  return dump(
    {
      schema_version: 1,
      id,
      title,
      base_sha: null,
      max_wall_minutes: 30,
      allowed_globs: ['src/**'],
      forbidden_globs: [],
      max_changed_lines: 400,
      build_ref: 'build',
      test_ref: 'test',
      verification_params: {},
    },
    { lineWidth: 120 },
  );
}

// -- verbs ------------------------------------------------------------------

const init: Handler = (ctx) => {
  const root = join(ctx.cwd, ROUTER_DIR);
  const force = flagBool(ctx.args.flags, 'force');
  const paths = routerPaths(root);
  const created: string[] = [];
  for (const d of [paths.root, paths.tasksDir, paths.worktreesDir, paths.contextDir]) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      created.push(d);
    }
  }
  if (!existsSync(paths.policy) || force) writeFileSync(paths.policy, POLICY_TEMPLATE);
  if (!existsSync(paths.registry)) {
    store.writeRegistry(paths, { schema_version: 1, rebuilt_at: systemClock.nowIso(), tasks: {} });
  }
  const gi = join(paths.root, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, 'worktrees/\n');
  emit(ctx.json, { ok: true, root: paths.root, created }, () => `initialized ${paths.root}`);
  return 0;
};

const newTask: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  const title = flagStr(ctx.args.flags, 'title') ?? id;
  createTask(deps, id, title);
  if (!existsSync(paths.taskYaml(id))) writeFileSync(paths.taskYaml(id), taskTemplate(id, title));
  if (!existsSync(paths.contractMd(id))) writeFileSync(paths.contractMd(id), CONTRACT_TEMPLATE(id, title));
  if (!existsSync(paths.planMd(id))) writeFileSync(paths.planMd(id), `# Plan: ${title}\n`);
  emit(ctx.json, { ok: true, id, state: 'DRAFT', task_yaml: paths.taskYaml(id) }, () =>
    `created ${id} (DRAFT) - edit ${paths.taskYaml(id)} and TASK_CONTRACT.md, then \`router validate ${id}\``,
  );
  return 0;
};

const validate: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);

  const yamlText0 = readFileSync(paths.taskYaml(id), 'utf8');
  const parsed = validateTaskYaml(load(yamlText0, { schema: JSON_SCHEMA }));
  if (!parsed.ok || parsed.value === null) {
    throw new CliError(`invalid task.yaml: ${parsed.errors.join('; ')}`, 1);
  }
  const repoRoot = paths.repoRoot;
  const baseSha = resolveCommit(repoRoot, parsed.value.base_sha ?? 'HEAD');

  // Freeze base_sha into the task file, then hash the final on-disk contract.
  const frozenTask: TaskYaml = { ...parsed.value, base_sha: baseSha };
  const yamlText = dump(frozenTask, { lineWidth: 120 });
  writeFileSync(paths.taskYaml(id), yamlText);
  const contractText = existsSync(paths.contractMd(id)) ? readFileSync(paths.contractMd(id), 'utf8') : '';
  const contractHash = hashContract(yamlText, contractText);

  // Gate: policy must exist at base_sha and define the referenced build/test refs.
  const policy = loadPolicyFromGit(paths, baseSha);
  for (const ref of [frozenTask.build_ref, frozenTask.test_ref]) {
    if (policy.verification[ref] === undefined) {
      throw new CliError(`verification ref '${ref}' not in policy.yaml at base_sha`, 1);
    }
  }

  if (st.state === 'VALIDATED' && st.contract_hash === contractHash) {
    emit(ctx.json, { ok: true, id, state: 'VALIDATED', base_sha: baseSha, idempotent: true }, () =>
      `${id} already VALIDATED (unchanged)`,
    );
    return 0;
  }
  transition(deps, id, 'VALIDATED', {
    actor: 'cli:validate',
    meta: { base_sha: baseSha, contract_hash: contractHash },
  });
  emit(ctx.json, { ok: true, id, state: 'VALIDATED', base_sha: baseSha, contract_hash: contractHash }, () =>
    `${id} VALIDATED (base_sha ${baseSha.slice(0, 12)})`,
  );
  return 0;
};

const simpleTransition =
  (to: TaskState, actor: string, okIfAlready: TaskState): Handler =>
  (ctx) => {
    const { deps, paths } = depsFor(ctx);
    const id = requireId(ctx);
    const st = currentState(paths, id);
    if (st === null) throw new CliError(`no such task: ${id}`, 3);
    if (st.state === okIfAlready || st.state === to) {
      emit(ctx.json, { ok: true, id, state: st.state, idempotent: true }, () => `${id} already ${st.state}`);
      return 0;
    }
    const next = transition(deps, id, to, { actor });
    emit(ctx.json, { ok: true, id, state: next.state }, () => `${id} -> ${next.state}`);
    return 0;
  };

const queue = simpleTransition('QUEUED', 'cli:queue', 'QUEUED');

const run: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  let started;
  try {
    started = startRun(deps, id);
  } catch (e) {
    // A budget/attempt cap is a deterministic refusal, not a crash - surface it
    // as a clean CLI error (json-aware) instead of a stack trace.
    if (e instanceof CapExceededError) throw new CliError(`refused: ${e.message}`, 1);
    throw e;
  }
  // Hand off to a detached self-supervising _worker-run process (survives session end).
  const script = process.argv[1] ?? '';
  const child = spawn(
    process.execPath,
    [script, '_worker-run', id, '--run', started.runId, '--router-dir', paths.root],
    { detached: true, stdio: 'ignore', cwd: paths.repoRoot, env: process.env },
  );
  // The detached child (_worker-run) is its own process-group leader: record its
  // pid as BOTH the supervisor pid and the supervisor's group. Locked RMW so it
  // can't clobber the child's concurrent worker_pgid write.
  if (child.pid !== undefined) {
    updateLease(deps, id, started.runId, { supervisor_pid: child.pid, supervisor_pgid: child.pid });
  }
  child.unref();
  emit(ctx.json, { ok: true, id, run: started.runId, state: 'RUNNING', supervisor_pid: child.pid }, () =>
    `${id} RUNNING ${started.runId} (detached pid ${child.pid}); poll \`router status ${id}\``,
  );
  return 0;
};

const workerRun: Handler = async (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  const runId = flagStr(ctx.args.flags, 'run');
  if (runId === undefined) throw new CliError('_worker-run requires --run', 2);
  const st = currentState(paths, id);
  if (st === null || st.base_sha === null) throw new CliError(`task ${id} not runnable`, 1);
  const policy = loadPolicyFromGit(paths, st.base_sha);
  const workers = policy.workers ?? (policy.worker ? [policy.worker] : []);
  if (workers.length === 0) throw new CliError('policy defines no worker/workers', 1);
  // A run started from ESCALATED_2 is the "rescue" attempt: use the rescue worker
  // (stronger/different model) instead of the normal chain. The rung was decided
  // by the state machine at finalize; we read it from this run's RUNNING event.
  const events = store.readEvents(paths, id);
  const runningEv = [...events].reverse().find((e) => e.to === 'RUNNING' && e.run_id === runId);
  let launchers;
  if (isRescueAttempt(runningEv?.from ?? null)) {
    // Rescue: a single stronger executor, with no fallback chain and no budget
    // reordering, so it can't silently downgrade to a weaker/cheaper model.
    const rescueWorker = resolveRescueWorker(policy);
    if (rescueWorker === undefined) throw new CliError('rescue attempt: no rescue worker resolvable', 1);
    launchers = [makeLauncher(rescueWorker)];
  } else {
    // Budget-aware routing reorders the fallback chain to start at the first executor
    // with window headroom (identity order when no budgets are configured).
    const { ordered } = planExecutorOrder(paths, Date.parse(deps.clock.nowIso()), policy, workers);
    launchers = ordered.map(makeLauncher);
  }
  const [primary, ...rest] = launchers;
  // Pass the policy through (no second git load) + the (reordered) fallback chain.
  const result = await runWorkerBody(deps, id, runId, primary!, policy, rest);
  return result.verifier?.result === 'PASSED' ? 0 : 1;
};

const merge: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);
  if (st.state === 'MERGED') {
    emit(ctx.json, { ok: true, id, state: 'MERGED', idempotent: true }, () => `${id} already MERGED`);
    return 0;
  }
  if (st.state !== 'PASSED') throw new CliError(`${id} is ${st.state}, not PASSED`, 1);
  const run = st.current_run;
  if (run === null) throw new CliError(`${id} has no run to merge`, 1);

  // Approval gate: a task whose allowed_globs can reach sensitive paths is
  // high-risk and must not merge without an explicit approval (a --approve on
  // this command, or a previously recorded `router approve`).
  const risk = classifyRisk(loadTask(paths, id).task.allowed_globs);
  if (risk.level === 'high') {
    const approvedFlag = flagBool(ctx.args.flags, 'approve');
    const recorded = store.readApproval(paths, id);
    if (!approvedFlag && recorded === null) {
      throw new CliError(
        `${id} is high-risk (${risk.reasons.join(', ')}); re-run with --approve or \`router approve ${id}\``,
        1,
      );
    }
    if (approvedFlag && recorded === null) {
      store.writeApproval(paths, id, {
        approved_at: systemClock.nowIso(),
        actor: 'cli:merge',
        ...(risk.reasons.length > 0 ? { risk_reasons: risk.reasons } : {}),
      });
    }
  }

  const repoRoot = paths.repoRoot;
  const branch = runBranch(id, run);
  try {
    mergeNoFF(repoRoot, branch);
  } catch (e) {
    // Restore the working tree - never leave the user in a half-merged state.
    mergeAbort(repoRoot);
    throw new CliError(`merge failed (aborted, tree restored): ${(e as Error).message}`, 1);
  }
  transition(deps, id, 'MERGED', { actor: 'cli:merge', runId: run });
  // Cleanup: remove the worktree and delete the run branch.
  worktreeRemove(repoRoot, paths.worktree(id, run));
  deleteBranch(repoRoot, branch);
  emit(ctx.json, { ok: true, id, state: 'MERGED', branch }, () => `${id} MERGED (${branch})`);
  return 0;
};

const status: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);
  const lease = st.current_run ? store.readLease(paths, id, st.current_run) : null;
  const events = store.readEvents(paths, id);
  emit(ctx.json, { ok: true, ...st, lease, recent: events.slice(-5) }, () => {
    const l = lease ? ` run=${st.current_run} sup_pid=${lease.supervisor_pid}` : '';
    return `${id}: ${st.state} (attempt ${st.attempt_number})${l}`;
  });
  return 0;
};

const list: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const filter = flagStr(ctx.args.flags, 'state');
  // Read the registry.json projection (updated on every transition) instead of
  // folding every task's full event log. Fall back to folding only if the registry
  // is absent (e.g. a freshly cloned .router before the first reindex).
  const reg = store.readRegistry(paths);
  let rows: { id: string; state: TaskState; run: string | null; title: string }[];
  if (reg !== null) {
    rows = Object.entries(reg.tasks)
      .map(([id, e]) => ({ id, state: e.state, run: e.current_run, title: e.title }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } else {
    rows = store
      .listTaskIds(paths)
      .map((id) => currentState(paths, id))
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s) => ({ id: s.id, state: s.state, run: s.current_run, title: s.title }));
  }
  const shown = rows.filter((r) => filter === undefined || r.state === filter);
  emit(ctx.json, { ok: true, tasks: shown }, () =>
    shown.length === 0 ? '(no tasks)' : shown.map((r) => `${r.state.padEnd(11)} ${r.id}`).join('\n'),
  );
  return 0;
};

const result: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);
  const run = flagStr(ctx.args.flags, 'run') ?? st.current_run;
  if (run === null) throw new CliError(`${id} has no run`, 1);
  const res = store.readResult(paths, id, run);
  if (res === null) throw new CliError(`no result for ${id} ${run}`, 3);
  let tail = '';
  try {
    tail = readFileSync(paths.workerLog(id, run), 'utf8').split('\n').slice(-50).join('\n');
  } catch {
    /* no log */
  }
  emit(ctx.json, { ok: true, result: res }, () => {
    const checks = (res.verifier?.checks ?? []).map((c) => `  ${c.ok ? 'ok' : 'x'} ${c.id}${c.detail ? ` - ${c.detail}` : ''}`).join('\n');
    return `${id} ${run}: exit=${res.exit_class} verifier=${res.verifier?.result ?? 'n/a'}\n${checks}\n--- log tail ---\n${tail}`;
  });
  return 0;
};

const usd = (v: number | null): string => (v === null ? 'n/a' : `$${v.toFixed(4)}`);
const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

/** Parse a duration like "90m", "24h", "7d" to milliseconds; null if malformed. */
function parseDurationMs(s: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(s.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

const stats: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const baseline = summarizeBaseline(store.readBaseline(paths));
  let metrics = store.readMetrics(paths);
  const since = flagStr(ctx.args.flags, 'since');
  if (since !== undefined) {
    const ms = parseDurationMs(since);
    if (ms === null) throw new CliError(`bad --since '${since}' (use e.g. 90m, 24h, 7d)`, 2);
    const cutoff = Date.now() - ms;
    metrics = metrics.filter((r) => Date.parse(r.ts) >= cutoff);
  }
  const s = aggregate(metrics, baseline);
  emit(ctx.json, { ok: true, ...s }, () => {
    const perTask = s.verifiedRuns > 0 ? Math.round(s.tokensTotal / s.verifiedRuns) : 0;
    const lines = [
      `runs ${s.totalRuns}  verified ${s.verifiedRuns}  first-pass ${pct(s.firstPassRate)}  env_error ${s.envErrorRuns}`,
      `spent:    ${s.tokensInput} in + ${s.tokensOutput} out tokens (${usd(s.spentUsd)})  [~${perTask}/verified task]`,
    ];
    if (baseline !== null) {
      lines.push(
        `baseline: ${Math.round(baseline.tokensPerTask)} tokens/task (${usd(baseline.costUsdPerTask)}/task, n=${baseline.n})`,
        `offloaded: ${s.offloadedTokens} baseline tokens  |  net saved: ${usd(s.savedUsd)} (${pct(s.savedPct)})`,
      );
    } else {
      lines.push('baseline: none - `router baseline add ...` to compute savings');
    }
    return lines.join('\n');
  });
  return 0;
};

const baseline: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const sub = ctx.args.positionals[0];
  if (sub === 'list') {
    const records = store.readBaseline(paths);
    emit(ctx.json, { ok: true, records }, () =>
      records.length === 0
        ? '(no baseline records)'
        : records
            .map((r) => `${r.ts}  ${r.task_id ?? '-'}  ${r.tokens_input}+${r.tokens_output} tok  ${usd(r.cost_usd)}`)
            .join('\n'),
    );
    return 0;
  }
  if (sub !== 'add') throw new CliError('usage: router baseline add|list', 2);

  const tin = Number(flagStr(ctx.args.flags, 'tokens-in'));
  const tout = Number(flagStr(ctx.args.flags, 'tokens-out'));
  if (!Number.isFinite(tin) || !Number.isFinite(tout)) {
    throw new CliError('baseline add requires --tokens-in and --tokens-out', 2);
  }
  const costStr = flagStr(ctx.args.flags, 'cost-usd');
  const wallStr = flagStr(ctx.args.flags, 'wall');
  const record: BaselineRecord = {
    ts: systemClock.nowIso(),
    task_id: ctx.args.positionals[1] ?? null,
    model: flagStr(ctx.args.flags, 'model') ?? 'opus',
    tokens_input: tin,
    tokens_output: tout,
    cost_usd: costStr !== undefined ? Number(costStr) : null,
    wall_seconds: wallStr !== undefined ? Number(wallStr) : null,
  };
  store.appendBaseline(paths, record);
  const n = store.readBaseline(paths).length;
  emit(ctx.json, { ok: true, record, count: n }, () => `recorded baseline (${tin}+${tout} tok), ${n} total`);
  return 0;
};

const cancel: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);
  if (isTerminal(st.state)) {
    emit(ctx.json, { ok: true, id, state: st.state, idempotent: true }, () => `${id} already ${st.state}`);
    return 0;
  }
  if (st.state === 'RUNNING' && st.current_run) {
    const lease = store.readLease(paths, id, st.current_run);
    if (lease) {
      // Kill the supervisor group FIRST so _worker-run can't proceed to verify/
      // finalize after we cancel, then the worker group.
      const supGroup = lease.supervisor_pgid ?? lease.supervisor_pid;
      if (supGroup > 1) killProcessGroup(supGroup, 'SIGKILL');
      if (lease.worker_pgid > 1) killProcessGroup(lease.worker_pgid, 'SIGKILL');
    }
  }
  const next = transition(deps, id, 'CANCELLED', { actor: 'cli:cancel', runId: st.current_run });
  emit(ctx.json, { ok: true, id, state: next.state }, () => `${id} CANCELLED`);
  return 0;
};

const recoverCmd: Handler = (ctx) => {
  const { deps } = depsFor(ctx);
  const r = recover(deps);
  emit(ctx.json, { ok: true, ...r }, () =>
    `recovered ${r.recovered.length}, still running ${r.stillRunning.length}, reindex errors ${r.reindexErrors.length}`,
  );
  return 0;
};

const reindex: Handler = (ctx) => {
  const { deps } = depsFor(ctx);
  const r = rebuildRegistry(deps);
  emit(ctx.json, { ok: true, tasks: Object.keys(r.registry.tasks).length, errors: r.errors }, () =>
    `reindexed ${Object.keys(r.registry.tasks).length} tasks, ${r.errors.length} errors`,
  );
  return 0;
};

const approve: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const st = currentState(paths, id);
  if (st === null) throw new CliError(`no such task: ${id}`, 3);
  const risk = classifyRisk(loadTask(paths, id).task.allowed_globs);
  store.writeApproval(paths, id, {
    approved_at: systemClock.nowIso(),
    actor: 'cli:approve',
    ...(risk.reasons.length > 0 ? { risk_reasons: risk.reasons } : {}),
  });
  emit(ctx.json, { ok: true, id, risk: risk.level, reasons: risk.reasons }, () =>
    `${id} approved (risk ${risk.level}${risk.reasons.length > 0 ? ': ' + risk.reasons.join(', ') : ''})`,
  );
  return 0;
};

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

const gc: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const dryRun = flagBool(ctx.args.flags, 'dry-run');

  // metrics.jsonl retention: keep the most-recent N (default 1000), optionally
  // also dropping anything older than --since; rotate dropped -> metrics.jsonl.1.
  const keepStr = flagStr(ctx.args.flags, 'keep-metrics');
  const keepLast = keepStr !== undefined && keepStr !== '' ? Number(keepStr) : 1000;
  if (!Number.isFinite(keepLast) || keepLast < 0) {
    throw new CliError(`bad --keep-metrics '${keepStr}'`, 2);
  }
  const retOpts: { keepLast: number; maxAgeMs?: number; nowMs?: number } = { keepLast };
  const since = flagStr(ctx.args.flags, 'since');
  if (since !== undefined) {
    const ms = parseDurationMs(since);
    if (ms === null) throw new CliError(`bad --since '${since}' (use e.g. 90m, 24h, 7d)`, 2);
    retOpts.maxAgeMs = ms;
    retOpts.nowMs = Date.now();
  }
  const metrics = store.readMetrics(paths);
  const retention = planMetricRetention(metrics, retOpts);

  // run worktree GC: only ever for terminal tasks (planRunGc enforces this).
  const tasks: TaskGcInput[] = store.listTaskIds(paths).map((id) => {
    const st = currentState(paths, id);
    return { id, state: st?.state ?? 'CANCELLED', worktrees: store.listWorktreeRuns(paths, id) };
  });
  const plan = planRunGc(tasks);
  let freedBytes = 0;
  for (const a of plan.remove) freedBytes += store.pathSizeBytes(paths.worktree(a.taskId, a.runId));

  if (!dryRun) {
    if (retention.dropped.length > 0) {
      store.writeMetricsArchive(paths, retention.dropped);
      store.overwriteMetrics(paths, retention.keep);
    }
    const touchedTasks = new Set<string>();
    for (const a of plan.remove) {
      worktreeRemove(paths.repoRoot, paths.worktree(a.taskId, a.runId));
      touchedTasks.add(a.taskId);
    }
    for (const id of touchedTasks) store.removeEmptyWorktreeParent(paths, id);
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    metrics_dropped: retention.dropped.length,
    metrics_kept: retention.keep.length,
    worktrees_removed: plan.remove.map((a) => `${a.taskId}/${a.runId}`),
    freed_bytes: freedBytes,
    skipped: plan.skipped,
  };
  emit(ctx.json, summary, () => {
    const verb = dryRun ? 'would free' : 'freed';
    const skip =
      plan.skipped.length > 0
        ? `\n  kept ${plan.skipped.length} non-terminal task(s) with worktrees: ${plan.skipped.map((s) => `${s.taskId}(${s.state})`).join(', ')}`
        : '';
    return (
      `gc${dryRun ? ' (dry-run)' : ''}: metrics dropped ${retention.dropped.length}, kept ${retention.keep.length}; ` +
      `${verb} ${plan.remove.length} worktree(s) (${fmtBytes(freedBytes)})${skip}`
    );
  });
  return 0;
};

const routing: Handler = (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const policy = loadPolicyFromDisk(paths);
  const workers = policy.workers ?? (policy.worker ? [policy.worker] : []);
  if (workers.length === 0) throw new CliError('policy defines no worker/workers', 1);
  const { ordered, view } = planExecutorOrder(paths, Date.parse(deps.clock.nowIso()), policy, workers);
  emit(ctx.json, { ok: true, order: ordered.map((w) => w.kind), ...view }, () => {
    const lines = [
      `order: ${ordered.map((w) => w.kind).join(' -> ')}` +
        (view.budgeted ? '' : '   (no budgets configured; identity order)'),
    ];
    for (const e of view.decision.entries) {
      const b = view.budgets.find((x) => x.kind === e.kind);
      if (e.budget_tokens === null) {
        lines.push(`  ${e.kind}: unbounded (no budget)`);
        continue;
      }
      const frac = e.fraction === null ? 'n/a' : `${Math.round(e.fraction * 100)}%`;
      const cal =
        b !== undefined && Math.round(b.effective_tokens) !== b.seed_tokens
          ? ` (seed ${b.seed_tokens} -> calibrated ${Math.round(b.effective_tokens)})`
          : '';
      lines.push(
        `  ${e.kind}: ${Math.round(e.consumed)}+${Math.round(e.estimate)}/${e.budget_tokens} tok = ${frac} ${e.fits ? 'ok' : 'OVER'}${cal}`,
      );
    }
    if (!view.decision.anyFits && view.budgeted) {
      lines.push('  all executors at/over budget; starting the one with most headroom (reactive 429 still backs this up)');
    }
    return lines.join('\n');
  });
  return 0;
};

const plan: Handler = async (ctx) => {
  const { deps } = depsFor(ctx);
  const goal = flagStr(ctx.args.flags, 'goal') ?? ctx.args.positionals[0];
  if (goal === undefined || goal.trim() === '') throw new CliError('usage: router plan "<goal>"', 2);
  const idFlag = flagStr(ctx.args.flags, 'id');
  const outcome = runPlan(deps, goal, idFlag !== undefined ? { id: idFlag } : {});
  if (!outcome.ok) throw new CliError(`plan rejected:\n  - ${outcome.errors.join('\n  - ')}`, 1);

  const id = outcome.id;
  if (!flagBool(ctx.args.flags, 'execute')) {
    emit(
      ctx.json,
      { ok: true, id, state: 'DRAFT', risk: outcome.risk.level, reasons: outcome.risk.reasons, truncated: outcome.truncated },
      () =>
        `planned ${id} (DRAFT, risk ${outcome.risk.level}); review .router/tasks/${id}/, then \`router validate ${id}\` or re-run with --execute`,
    );
    return 0;
  }
  // --execute: chain the existing pipeline (each step owns its own gates).
  const chainCtx: Ctx = { ...ctx, args: { ...ctx.args, flags: { ...ctx.args.flags, id } } };
  validate(chainCtx);
  queue(chainCtx);
  return await run(chainCtx);
};

const selftestCmd: Handler = async (ctx) => {
  const { selftest } = await import('../app/selftest.ts');
  const r = await selftest({ keep: flagBool(ctx.args.flags, 'keep') });
  emit(ctx.json, { ok: r.ok, canaries: r.canaries }, () =>
    r.canaries.map((c) => `  ${c.ok ? 'ok' : 'x'} ${c.name}: ${c.actual} (${c.detail})`).join('\n') +
    `\n${r.ok ? 'selftest PASSED' : 'selftest FAILED'}`,
  );
  return r.ok ? 0 : 1;
};

export const HANDLERS: Record<string, Handler> = {
  init,
  new: newTask,
  plan,
  validate,
  queue,
  run,
  '_worker-run': workerRun,
  merge,
  approve,
  status,
  list,
  result,
  stats,
  baseline,
  routing,
  cancel,
  gc,
  recover: recoverCmd,
  reindex,
  selftest: selftestCmd,
};

export function versionText(): string {
  return VERSION;
}

export function helpText(): string {
  return (
    `router ${VERSION}\n\n` +
    `Usage: router <command> [options]\n\n` +
    `Lifecycle:  init * new * plan * validate * queue * run * status * result * approve * merge\n` +
    `Ops:        list * stats * baseline * routing * cancel * gc * recover * reindex * selftest\n\n` +
    `Flags: --json, --id, --title, --run, --state, --force, --keep, --approve,\n` +
    `       --dry-run, --keep-metrics, --since, --execute\n`
  );
}
