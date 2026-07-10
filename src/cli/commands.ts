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
import { systemClock } from '../io/clock.ts';
import { deleteBranch, mergeAbort, mergeNoFF, resolveCommit, worktreeRemove } from '../io/git.ts';
import { findRouterDir, routerPaths, runBranch, type RouterPaths } from '../io/paths.ts';
import { killProcessGroup } from '../io/signals.ts';
import * as store from '../io/store.ts';
import { createTask, currentState, transition, type TransitionDeps } from '../app/transition.ts';
import { recover } from '../app/recover.ts';
import { rebuildRegistry } from '../app/registry.ts';
import { loadPolicyFromGit } from '../app/policyLoad.ts';
import { codexLauncher } from '../app/codexLauncher.ts';
import { runWorkerBody, startRun, updateLease } from '../app/worker.ts';
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
worker:
  kind: codex
  api_key_env: OPENAI_API_KEY
  max_wall_minutes_default: 30
  stall_minutes: 10
scope:
  forbidden_globs: [".router/**", "**/*.lock"]
  test_globs: ["tests/**", "**/*_test.*", "**/*.test.*"]
  max_changed_lines: 400
verification:
  build:
    - ["make", "-C", "{build_dir}"]
  test:
    - ["ctest", "--test-dir", "{build_dir}", "--output-on-failure"]
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
      verification_params: { build_dir: 'build' },
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
  const started = startRun(deps, id);
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
  const launcher = codexLauncher(policy);
  const result = await runWorkerBody(deps, id, runId, launcher);
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
  const rows = store
    .listTaskIds(paths)
    .map((id) => currentState(paths, id))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .filter((s) => filter === undefined || s.state === filter)
    .map((s) => ({ id: s.id, state: s.state, run: s.current_run, title: s.title }));
  emit(ctx.json, { ok: true, tasks: rows }, () =>
    rows.length === 0 ? '(no tasks)' : rows.map((r) => `${r.state.padEnd(11)} ${r.id}`).join('\n'),
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

const stats: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const baseline = summarizeBaseline(store.readBaseline(paths));
  const s = aggregate(store.readMetrics(paths), baseline);
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
  validate,
  queue,
  run,
  '_worker-run': workerRun,
  merge,
  status,
  list,
  result,
  stats,
  baseline,
  cancel,
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
    `Lifecycle:  init * new * validate * queue * run * status * result * merge\n` +
    `Ops:        list * stats * baseline * cancel * recover * reindex * selftest\n\n` +
    `Flags: --json, --id, --title, --run, --state, --force, --keep\n`
  );
}
