// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { PlanCheckResult, ProposedContract } from '../domain/types.ts';
import { matchGlob } from './glob.ts';

// Deterministic validation of a planner's proposed contract (PURE). claude's output
// is untrusted: this is the gate that stops a malformed or over-broad proposal.
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

export function parseAndCheck(rawText: string, ctx: PlanCheckContext): PlanCheckResult {
  const jsonText = extractJsonObject(rawText);
  if (jsonText === null) return { ok: false, errors: ['no JSON object found in planner output'] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`planner output is not valid JSON: ${(e as Error).message}`] };
  }

  const errors: string[] = [];
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

  if (!ID_RE.test(str('id'))) errors.push('id must be a kebab-case slug');
  if (str('title').trim() === '') errors.push('title must be a non-empty string');
  if (str('contract_md').trim() === '') errors.push('contract_md must be a non-empty string');

  const globs = obj['allowed_globs'];
  const globList: string[] =
    Array.isArray(globs) && globs.every((g) => typeof g === 'string') ? (globs as string[]) : [];
  if (globList.length === 0) errors.push('allowed_globs must be a non-empty string array');
  for (const g of globList) {
    if (BROAD.has(g.trim())) errors.push(`allowed_glob '${g}' is too broad`);
    else if (!ctx.trackedFiles.some((f) => matchGlob(f, g))) errors.push(`allowed_glob '${g}' matches no tracked file`);
  }

  for (const ref of ['build_ref', 'test_ref']) {
    const v = str(ref);
    if (v === '') errors.push(`${ref} must be a non-empty string`);
    else if (!ctx.policyRefs.includes(v)) errors.push(`${ref} '${v}' not in policy.verification (${ctx.policyRefs.join(', ')})`);
  }

  const mcl = obj['max_changed_lines'];
  if (typeof mcl !== 'number' || !Number.isInteger(mcl) || mcl <= 0) errors.push('max_changed_lines must be a positive integer');
  else if (mcl > MAX_CHANGED_LINES_CEILING) errors.push(`max_changed_lines ${mcl} exceeds ceiling ${MAX_CHANGED_LINES_CEILING}`);

  if (errors.length > 0) return { ok: false, errors };

  const fg = obj['forbidden_globs'];
  const contract: ProposedContract = {
    id: str('id'),
    title: str('title'),
    allowed_globs: globList,
    forbidden_globs: Array.isArray(fg) && fg.every((g) => typeof g === 'string') ? (fg as string[]) : [],
    max_changed_lines: mcl as number,
    build_ref: str('build_ref'),
    test_ref: str('test_ref'),
    contract_md: str('contract_md'),
  };
  return { ok: true, contract };
}
