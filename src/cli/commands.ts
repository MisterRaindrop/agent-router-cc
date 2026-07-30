// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { ROUTER_DIR, VERSION } from '../domain/constants.ts';
import { systemClock, type Clock } from '../io/clock.ts';
import { writeJsonAtomic } from '../io/atomicWrite.ts';
import { deleteBranch, mergeAbort, mergeNoFF, resolveCommit, worktreeRemove } from '../io/git.ts';
import { findRouterDir, routerPaths, runBranch, runId as fmtRunId, type RouterPaths } from '../io/paths.ts';
import * as store from '../io/store.ts';
import { dispatchTask, resumeTask } from '../app/dispatch.ts';
import { loadModelConfig, modelsYamlPath } from '../app/modelConfig.ts';
import { recordOrchestratorUsage } from '../app/orchestratorUsage.ts';
import { isDegraded, loadCodeIntelConfig, runIndex, runQuery } from '../app/symbolIndex.ts';
import { parseSymbols } from '../io/treeSitter.ts';
import { buildUsageReport, explainSavingsText, renderUsage } from '../app/usageReport.ts';
import { STRONG_BASELINE_MODEL } from '../core/pricing.ts';
import { planStatusLine } from '../core/statuslineSetup.ts';
import { CliError, emit } from './output.ts';
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
function depsFor(ctx: Ctx): Deps {
  const explicit = flagStr(ctx.args.flags, 'router-dir');
  const found = explicit ?? findRouterDir(ctx.cwd);
  const rd = found ?? join(ctx.cwd, ROUTER_DIR);
  const paths = routerPaths(rd);
  for (const d of [paths.root, paths.tasksDir, paths.worktreesDir]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const gi = join(paths.root, '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n');
  return { paths, clock: systemClock };
}

function requireId(ctx: Ctx): string {
  const id = flagStr(ctx.args.flags, 'id') ?? ctx.args.positionals[0];
  if (id === undefined || id === '') throw new CliError('missing task id', 2);
  return id;
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
// The test-hygiene block is boilerplate on purpose: these are the mistakes BOTH cheap
// and strong models make (measured, not guessed) -- a fixed global resource name that
// collides when a test runner repeats the test, state left behind when a test aborts
// mid-way, and a test script created without its executable bit. Keep this block short:
// a longer contract gets skimmed, which defeats the point.
const contractTemplate = (id: string, title: string): string =>
  `# ${title}\n\ntask: ${id}\n\n## Goal\n\n_What to accomplish._\n\n## Definition of Done\n\n- [ ] ...\n` +
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
  const id = requireId(ctx);
  const result = await dispatchTask(deps, id);
  const v = result.verifier?.result ?? 'FAILED';
  emit(
    ctx.json,
    {
      ok: v === 'PASSED',
      id,
      executor: result.worker.kind,
      model: result.worker.model ?? null,
      verifier: v,
      exit_class: result.exit_class,
      tokens: result.tokens ?? null,
      cost_usd: result.cost_usd ?? null,
      executor_switches: result.executor_switches ?? 0,
      model_mismatch: result.model_mismatch ?? false,
    },
    () => {
      const who = `${result.worker.kind}${result.worker.model ? `/${result.worker.model}` : ''}`;
      const sw = result.executor_switches ? `, switched ${result.executor_switches}x` : '';
      const next = v === 'PASSED' ? `review the diff, then \`router land ${id}\`` : `see \`router result ${id}\``;
      const warn = result.model_mismatch
        ? `\nWARNING: ${result.worker.kind} rejected model '${result.worker.model ?? '?'}' -- your model config may be stale ` +
          `(provider updated its lineup, or your plan lacks this tier). Edit .router/models.yaml; nothing was changed automatically.`
        : '';
      return `${id}: ${v} (executor ${who}${sw}); ${next}${warn}`;
    },
  );
  return v === 'PASSED' ? 0 : 1;
};

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
  const v = result.verifier?.result ?? 'FAILED';
  emit(
    ctx.json,
    {
      ok: !mism && v === 'PASSED',
      id,
      resumed: true,
      session_mismatch: mism,
      session_id: result.session_id ?? null,
      verifier: v,
      exit_class: result.exit_class,
    },
    () => {
      if (mism)
        return `${id}: RESUME DID NOT RE-ATTACH -- executor reported a new session id (${result.session_id}); nothing committed. Re-dispatch, or check the resume invocation.`;
      const next = v === 'PASSED' ? `review the diff, then \`router land ${id}\`` : `see \`router result ${id}\``;
      return `${id}: resumed -> ${v} (${result.exit_class}); ${next}`;
    },
  );
  return !mism && v === 'PASSED' ? 0 : 1;
};

const land: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const result = store.readResult(paths, id, RUN);
  if (result === null) throw new CliError(`${id}: no dispatch result to land (run \`router dispatch ${id}\` first)`, 1);
  if (result.verifier?.result !== 'PASSED') throw new CliError(`${id}: last dispatch was not PASSED`, 1);
  const branch = runBranch(id, RUN);
  try {
    mergeNoFF(paths.repoRoot, branch);
  } catch (e) {
    mergeAbort(paths.repoRoot);
    throw new CliError(`merge failed (aborted, tree restored): ${(e as Error).message}`, 1);
  }
  // The run branch is deleted right after the merge, so record the merge commit: it is
  // the only durable handle on what this task changed (`git show <sha>`). Without it a
  // later review or post-mortem has no way back to the task's diff.
  const mergeCommit = resolveCommit(paths.repoRoot, 'HEAD');
  worktreeRemove(paths.repoRoot, paths.worktree(id, RUN));
  deleteBranch(paths.repoRoot, branch);
  store.writeResult(paths, id, RUN, { ...result, merge_commit: mergeCommit });
  emit(ctx.json, { ok: true, id, merged: branch, merge_commit: mergeCommit }, () =>
    `${id} landed (${branch} -> ${mergeCommit.slice(0, 12)}); diff: git show ${mergeCommit.slice(0, 12)}`,
  );
  return 0;
};

const result: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const id = requireId(ctx);
  const run = flagStr(ctx.args.flags, 'run') ?? RUN;
  const res = store.readResult(paths, id, run);
  if (res === null) throw new CliError(`no result for ${id} ${run} (dispatch it first)`, 3);
  let tail = '';
  try {
    tail = readFileSync(paths.workerLog(id, run), 'utf8').split('\n').slice(-50).join('\n');
  } catch {
    /* no log */
  }
  emit(ctx.json, { ok: true, result: res }, () => {
    const checks = (res.verifier?.checks ?? [])
      .map((c) => `  ${c.ok ? 'ok' : 'x'} ${c.id}${c.detail ? ` - ${c.detail}` : ''}`)
      .join('\n');
    return `${id} ${run}: exit=${res.exit_class} verifier=${res.verifier?.result ?? 'n/a'}\n${checks}\n--- log tail ---\n${tail}`;
  });
  return 0;
};

// List authored tasks with their last dispatch status and whether a worktree is
// still on disk (read-only; helps you see leftovers before cleaning them).
const list: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
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
    const res = store.readResult(paths, id, RUN);
    const status = res === null ? 'none' : (res.verifier?.result ?? res.exit_class);
    const worktree = existsSync(paths.worktree(id, RUN));
    return { id, title, status, worktree };
  });
  emit(ctx.json, { ok: true, tasks: rows }, () => {
    if (rows.length === 0) return 'No tasks in .router/tasks.';
    const lines = [`Tasks (${rows.length}):`, pad('id', 22) + pad('status', 10) + pad('worktree', 10) + 'title'];
    for (const r of rows) lines.push(pad(r.id, 22) + pad(String(r.status), 10) + pad(r.worktree ? 'present' : '-', 10) + r.title);
    const leftover = rows.filter((r) => r.worktree).length;
    if (leftover > 0)
      lines.push(`\n${leftover} worktree(s) still on disk. Land the task to clean it, or remove .router/worktrees/<id> manually (a fail-close \`router clean\` is planned).`);
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
  const recorded = recordOrchestratorUsage(paths, clock, {
    planId,
    sinceIso,
    model,
    ...(untilIso !== undefined ? { untilIso } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    ...(projectsDir !== undefined ? { projectsDir } : {}),
  });

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
  const current = settings.statusLine as { command?: unknown } | undefined;
  const existingCmd = typeof current?.command === 'string' ? current.command : undefined;
  const plan = planStatusLine(existingCmd, statuslinePath);

  const changed = plan.action !== 'already-configured';
  if (changed && !dryRun) {
    settings.statusLine = { type: 'command', command: plan.command };
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
      const head =
        plan.action === 'already-configured'
          ? `already configured (${settingsPath})`
          : dryRun
            ? `would ${plan.action} statusLine in ${settingsPath}`
            : `${plan.action} statusLine in ${settingsPath}`;
      const chain = plan.inner ? `\n  chained your existing statusline: ${plan.inner}` : '';
      const warn = missing ? `\n  WARNING: ${statuslinePath} not found (pass --statusline <path>)` : '';
      const note = changed && !dryRun ? '\n  restart Claude Code (or reload) for it to take effect' : '';
      return `${head}\n  command: ${plan.command}${chain}${warn}${note}`;
    },
  );
  return 0;
};

// Print the resolved model-tier config (bundled default overlaid with any
// .router/models.yaml). Read by the go/spec/review prompts to pick tier models
// and the reviewer chain deterministically.
const models: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
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
  const { paths } = depsFor(ctx);
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

export const HANDLERS: Record<string, Handler> = {
  init,
  new: newTask,
  dispatch,
  resume,
  land,
  result,
  list,
  usage,
  'orchestrator-usage': orchestratorUsage,
  models,
  symbol,
  doctor,
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
    `  dispatch <id>          run the task on the quota-picked executor to a verified diff\n` +
    `  resume <id> --feedback continue the prior executor session with feedback (no cold restart)\n` +
    `  land <id>              merge a PASSED dispatch's diff\n` +
    `  result <id>            show the verifier report + log tail\n` +
    `  list                   list tasks with last status + whether a worktree remains\n` +
    `  usage [--all]          token/cost usage across recent dispatches (last 7 days)\n` +
    `  orchestrator-usage --plan <id> --since <iso>  record main-model usage from a Claude transcript\n` +
    `  models                 print the resolved model-tier config (default + .router/models.yaml)\n` +
    `  symbol <sub> [args]    out-of-context symbol index: index [dirs] | find <name> | enclosing <file> <line> | methods <Class> | callers <name> | callees <fn>\n` +
    `  doctor                 self-check the code-intelligence layer (config, wasm, cache)\n` +
    `  setup-statusline       wire claude-quota reads into Claude Code's statusLine\n` +
    `  init                   optional; router auto-creates .router/ on first use\n\n` +
    `Flags: --json, --all, --limit, --id, --title, --run, --router-dir, --settings, --statusline, --dry-run\n`
  );
}
