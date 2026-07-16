// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { ROUTER_DIR, VERSION } from '../domain/constants.ts';
import { systemClock, type Clock } from '../io/clock.ts';
import { deleteBranch, mergeAbort, mergeNoFF, worktreeRemove } from '../io/git.ts';
import { findRouterDir, routerPaths, runBranch, runId as fmtRunId, type RouterPaths } from '../io/paths.ts';
import * as store from '../io/store.ts';
import { dispatchTask } from '../app/dispatch.ts';
import { CliError, emit } from './output.ts';
import { flagStr, type ParsedArgs } from './args.ts';

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
const contractTemplate = (id: string, title: string): string =>
  `# ${title}\n\ntask: ${id}\n\n## Goal\n\n_What to accomplish._\n\n## Definition of Done\n\n- [ ] ...\n`;

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
    },
    () => {
      const who = `${result.worker.kind}${result.worker.model ? `/${result.worker.model}` : ''}`;
      const sw = result.executor_switches ? `, switched ${result.executor_switches}x` : '';
      const next = v === 'PASSED' ? `review the diff, then \`router land ${id}\`` : `see \`router result ${id}\``;
      return `${id}: ${v} (executor ${who}${sw}); ${next}`;
    },
  );
  return v === 'PASSED' ? 0 : 1;
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
  worktreeRemove(paths.repoRoot, paths.worktree(id, RUN));
  deleteBranch(paths.repoRoot, branch);
  emit(ctx.json, { ok: true, id, merged: branch }, () => `${id} landed (${branch})`);
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

export const HANDLERS: Record<string, Handler> = {
  init,
  new: newTask,
  dispatch,
  land,
  result,
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
    `  land <id>              merge a PASSED dispatch's diff\n` +
    `  result <id>            show the verifier report + log tail\n` +
    `  init                   optional; router auto-creates .router/ on first use\n\n` +
    `Flags: --json, --id, --title, --run, --router-dir\n`
  );
}
