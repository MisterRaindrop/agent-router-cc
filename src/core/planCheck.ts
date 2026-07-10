// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type {
  HandbackItem,
  PlanBatchResult,
  PlanCheckResult,
  ProposedContract,
  ProposedTask,
} from '../domain/types.ts';
import { matchGlob } from './glob.ts';

// Deterministic validation of a planner's proposed contract batch (PURE). claude's
// output is untrusted: this is the gate that stops a malformed or over-broad
// proposal. Clear tasks get full contract checks; unclear tasks only need an
// id/title (they are handed back to the main session, never dispatched).
const MAX_CHANGED_LINES_CEILING = 2000;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const BROAD = new Set(['*', '**', '**/*', '**/**']);

export interface PlanCheckContext {
  policyRefs: readonly string[];
  trackedFiles: readonly string[];
}

// Extract the first balanced top-level JSON object from arbitrary text.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Field checks for one CLEAR task object; returns the contract or errors.
function checkContractFields(
  obj: Record<string, unknown>,
  ctx: PlanCheckContext,
  label: string,
): { contract?: ProposedContract; errors: string[] } {
  const errors: string[] = [];
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

  if (!ID_RE.test(str('id'))) errors.push(`${label}id must be a kebab-case slug`);
  if (str('title').trim() === '') errors.push(`${label}title must be a non-empty string`);
  if (str('contract_md').trim() === '') errors.push(`${label}contract_md must be a non-empty string`);

  const globs = obj['allowed_globs'];
  const globList: string[] =
    Array.isArray(globs) && globs.every((g) => typeof g === 'string') ? (globs as string[]) : [];
  if (globList.length === 0) errors.push(`${label}allowed_globs must be a non-empty string array`);
  for (const g of globList) {
    if (BROAD.has(g.trim())) errors.push(`${label}allowed_glob '${g}' is too broad`);
    else if (!ctx.trackedFiles.some((f) => matchGlob(f, g))) errors.push(`${label}allowed_glob '${g}' matches no tracked file`);
  }

  for (const ref of ['build_ref', 'test_ref']) {
    const v = str(ref);
    if (v === '') errors.push(`${label}${ref} must be a non-empty string`);
    else if (!ctx.policyRefs.includes(v)) errors.push(`${label}${ref} '${v}' not in policy.verification (${ctx.policyRefs.join(', ')})`);
  }

  const mcl = obj['max_changed_lines'];
  if (typeof mcl !== 'number' || !Number.isInteger(mcl) || mcl <= 0) errors.push(`${label}max_changed_lines must be a positive integer`);
  else if (mcl > MAX_CHANGED_LINES_CEILING) errors.push(`${label}max_changed_lines ${mcl} exceeds ceiling ${MAX_CHANGED_LINES_CEILING}`);

  if (errors.length > 0) return { errors };
  const fg = obj['forbidden_globs'];
  return {
    errors: [],
    contract: {
      id: str('id'),
      title: str('title'),
      allowed_globs: globList,
      forbidden_globs: Array.isArray(fg) && fg.every((g) => typeof g === 'string') ? (fg as string[]) : [],
      max_changed_lines: mcl as number,
      build_ref: str('build_ref'),
      test_ref: str('test_ref'),
      contract_md: str('contract_md'),
    },
  };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : [];
}

/** Validate a planner batch: per-task checks on clear tasks + DAG checks batch-wide. */
export function parseAndCheckBatch(rawText: string, ctx: PlanCheckContext): PlanBatchResult {
  const jsonText = extractJsonObject(rawText);
  if (jsonText === null) return { ok: false, errors: ['no JSON object found in planner output'] };
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`planner output is not valid JSON: ${(e as Error).message}`] };
  }

  // Back-compat: a bare single task object (no "tasks" array) is one clear task.
  const bare = !Array.isArray(root['tasks']);
  const entries: Record<string, unknown>[] = bare
    ? [root]
    : (root['tasks'] as unknown[]).map((t) => (typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}));
  if (entries.length === 0) return { ok: false, errors: ['planner returned an empty task list'] };

  const errors: string[] = [];
  const tasks: ProposedTask[] = [];
  const handback: HandbackItem[] = [];
  const ids: string[] = [];

  for (const [i, obj] of entries.entries()) {
    const id = typeof obj['id'] === 'string' ? (obj['id'] as string) : `#${i}`;
    const label = `task ${id}: `;
    ids.push(id);
    const clarity = bare ? 'clear' : obj['clarity'];
    if (clarity !== 'clear' && clarity !== 'unclear') {
      errors.push(`${label}clarity must be "clear" or "unclear"`);
      continue;
    }
    const depends_on = strList(obj['depends_on']);
    if (clarity === 'unclear') {
      if (!ID_RE.test(id)) errors.push(`${label}id must be a kebab-case slug`);
      const title = typeof obj['title'] === 'string' ? (obj['title'] as string) : '';
      if (title.trim() === '') errors.push(`${label}title must be a non-empty string`);
      const reason = typeof obj['reason'] === 'string' ? (obj['reason'] as string) : undefined;
      handback.push({ id, title, depends_on, ...(reason !== undefined ? { reason } : {}) });
      continue;
    }
    const checked = checkContractFields(obj, ctx, label);
    if (checked.contract === undefined) errors.push(...checked.errors);
    else tasks.push({ ...checked.contract, clarity: 'clear', depends_on });
  }

  // Batch-level DAG checks.
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`duplicate task id '${id}' in batch`);
    seen.add(id);
  }
  const depsById = new Map<string, string[]>();
  for (const t of tasks) depsById.set(t.id, t.depends_on);
  for (const h of handback) depsById.set(h.id, h.depends_on);
  for (const [id, deps] of depsById) {
    for (const d of deps) if (!seen.has(d)) errors.push(`task ${id}: depends_on '${d}' is not in this batch`);
  }
  // Cycle detection (DFS over the batch graph).
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      errors.push(`dependency cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const d of depsById.get(id) ?? []) if (depsById.has(d)) visit(d, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of depsById.keys()) visit(id, []);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, tasks, handback };
}

/** Single-task validation (back-compat surface; same checks as a clear batch entry). */
export function parseAndCheck(rawText: string, ctx: PlanCheckContext): PlanCheckResult {
  const jsonText = extractJsonObject(rawText);
  if (jsonText === null) return { ok: false, errors: ['no JSON object found in planner output'] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`planner output is not valid JSON: ${(e as Error).message}`] };
  }
  const checked = checkContractFields(obj, ctx, '');
  if (checked.contract === undefined) return { ok: false, errors: checked.errors };
  return { ok: true, contract: checked.contract };
}
