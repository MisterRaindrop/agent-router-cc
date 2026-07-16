# `router plan` Orchestration Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `router plan "<goal>"` verb that uses a headless `claude` call to propose one task contract, validates the proposal deterministically, and materializes it at DRAFT (with `--execute` to chain the run pipeline).

**Architecture:** claude returns only a JSON contract proposal (an artifact). Pure `core` code checks it against the policy's verification refs and the repo's tracked files; `app` composes the io (git digest + claude spawn) with the pure checks and materializes the task; `cli` adds the verb. No existing gate changes.

**Tech Stack:** TypeScript on Node 22 (native type-stripping), `node:test`, `js-yaml`, esbuild bundle to `dist/router.js`.

## Global Constraints

- Node 22 native type-stripping: relative imports MUST end in `.ts`; NO `enum`, NO parameter properties, NO `namespace`.
- `tsconfig` has `erasableSyntaxOnly` and `exactOptionalPropertyTypes: true` -- never pass `undefined` to an optional property; build objects with conditional spread `{...(v !== undefined ? { k: v } : {})}`.
- Rings: `domain -> core -> io -> app -> cli`. `src/core/**` is PURE (no `fs`/`child_process`/`process`/`Date.now()`/`new Date()`/`Math.random()`, no importing io/app/cli), enforced by `scripts/check-deps.mjs`.
- ASCII only, no non-ASCII characters anywhere. New files start with:
  `// Copyright 2026 The agent-router-cc Authors`
  `// SPDX-License-Identifier: Apache-2.0`
- Commits: NO `Co-Authored-By` line.
- Gate: `npm run check` (tsc + check:deps + `node --test "test/**/*.test.ts"`) must pass; `npm run build` regenerates the committed `dist/router.js`; `node dist/router.js selftest` must print `selftest PASSED`.
- **Flag-name note:** the spec says `--run` to chain the pipeline, but `run` is already a value flag (`_worker-run --run <runId>`). This plan uses a boolean **`--execute`** instead to avoid the parser collision.

---

### Task 1: Domain types + planner prompt (pure)

**Files:**
- Modify: `src/domain/types.ts` (append new interfaces)
- Create: `src/core/planPrompt.ts`
- Test: `test/core-plan.test.ts`

**Interfaces:**
- Produces: `ProposedContract`, `RepoDigest` (domain); `buildPlannerPrompt(digest: RepoDigest, goal: string): string` (core).

- [ ] **Step 1: Add the types to `src/domain/types.ts`** (append near the end, after `RoutingObservation`)

```ts
// -- Orchestration (router plan): claude proposes a contract; router validates it --
export interface ProposedContract {
  id: string;
  title: string;
  allowed_globs: string[];
  forbidden_globs: string[];
  max_changed_lines: number;
  build_ref: string;
  test_ref: string;
  contract_md: string; // the TASK_CONTRACT.md body
}

export interface RepoDigest {
  files: readonly string[]; // git-tracked paths (may be capped; see `truncated`)
  truncated: boolean; // true when `files` was capped
  verificationRefs: readonly string[]; // policy.verification keys the plan may use
  readmeHead?: string; // first lines of README, when present
}

export type PlanCheckResult =
  | { ok: true; contract: ProposedContract }
  | { ok: false; errors: string[] };
```

- [ ] **Step 2: Write the failing test for `buildPlannerPrompt`** in `test/core-plan.test.ts`

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt } from '../src/core/planPrompt.ts';
import type { RepoDigest } from '../src/domain/types.ts';

const digest: RepoDigest = {
  files: ['src/a.ts', 'test/a.test.ts'],
  truncated: false,
  verificationRefs: ['build', 'test'],
  readmeHead: '# demo',
};

test('buildPlannerPrompt embeds the goal, the legal refs, and the file list', () => {
  const p = buildPlannerPrompt(digest, 'make a() faster');
  assert.match(p, /make a\(\) faster/);
  assert.match(p, /build, test/); // the legal verification refs
  assert.match(p, /src\/a\.ts/); // repo files
  assert.match(p, /bare "\*\*"/); // the scope constraint is stated
  assert.match(p, /ONLY a single JSON object/i);
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx tsc --noEmit && node --test test/core-plan.test.ts`
Expected: FAIL (cannot find `../src/core/planPrompt.ts`).

- [ ] **Step 4: Implement `src/core/planPrompt.ts`**

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { RepoDigest } from '../domain/types.ts';

// Builds the planner prompt (PURE). The planner must return ONLY a JSON contract;
// router validates that artifact deterministically (see core/planCheck.ts).
export function buildPlannerPrompt(digest: RepoDigest, goal: string): string {
  const refs = digest.verificationRefs.join(', ');
  const lines = [
    'You are a planning assistant for a deterministic coding-task router.',
    'Turn the GOAL into exactly ONE task contract.',
    'Respond with ONLY a single JSON object -- no prose, no markdown, no code fences.',
    '',
    'JSON shape:',
    '{',
    '  "id": "kebab-case-slug",',
    '  "title": "short imperative title",',
    '  "allowed_globs": ["smallest set of path globs that can satisfy the goal"],',
    '  "forbidden_globs": [],',
    '  "max_changed_lines": 100,',
    `  "build_ref": "one of: ${refs}",`,
    `  "test_ref": "one of: ${refs}",`,
    '  "contract_md": "markdown with a Goal section and a Definition of Done checklist"',
    '}',
    '',
    'Constraints:',
    '- allowed_globs must be minimal and match existing files; never use a bare "**".',
    '- build_ref and test_ref MUST be chosen from the list above.',
    '- max_changed_lines is a positive integer sized to the goal.',
    '',
    `GOAL: ${goal}`,
    '',
    'Repository files (git-tracked):',
    digest.files.join('\n'),
  ];
  if (digest.truncated) lines.push('(file list truncated)');
  if (digest.readmeHead !== undefined && digest.readmeHead !== '') {
    lines.push('', 'README (head):', digest.readmeHead);
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run the test, expect pass**

Run: `node --test test/core-plan.test.ts`
Expected: PASS (the `buildPlannerPrompt` subtests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/core/planPrompt.ts test/core-plan.test.ts
git commit -m "feat(plan): domain types + pure planner prompt"
```

---

### Task 2: Contract validation (pure)

**Files:**
- Create: `src/core/planCheck.ts`
- Test: `test/core-plan.test.ts` (extend)

**Interfaces:**
- Consumes: `ProposedContract`, `PlanCheckResult` (domain); `matchGlob(path, glob)` from `src/core/glob.ts`.
- Produces: `parseAndCheck(rawText: string, ctx: { policyRefs: readonly string[]; trackedFiles: readonly string[] }): PlanCheckResult`.

- [ ] **Step 1: Write failing tests** (append to `test/core-plan.test.ts`)

```ts
import { parseAndCheck } from '../src/core/planCheck.ts';

const CTX = { policyRefs: ['build', 'test'], trackedFiles: ['src/a.ts', 'src/b.ts', 'test/a.test.ts'] };
const good = {
  id: 'speed-up-a', title: 'Speed up a()', allowed_globs: ['src/**'], forbidden_globs: [],
  max_changed_lines: 80, build_ref: 'build', test_ref: 'test', contract_md: '# Speed up a()\n\n- [ ] faster',
};
const raw = (o) => JSON.stringify(o);

test('parseAndCheck accepts a well-formed contract', () => {
  const r = parseAndCheck(raw(good), CTX);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.contract.id, 'speed-up-a');
});

test('parseAndCheck tolerates surrounding prose and extracts the JSON object', () => {
  const r = parseAndCheck('Here is the plan:\n' + raw(good) + '\nDone.', CTX);
  assert.equal(r.ok, true);
});

test('parseAndCheck rejects an unknown build_ref', () => {
  const r = parseAndCheck(raw({ ...good, build_ref: 'nope' }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('build_ref')));
});

test('parseAndCheck rejects a bare ** glob', () => {
  const r = parseAndCheck(raw({ ...good, allowed_globs: ['**'] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('too broad')));
});

test('parseAndCheck rejects a glob matching no tracked file', () => {
  const r = parseAndCheck(raw({ ...good, allowed_globs: ['docs/**'] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('matches no tracked file')));
});

test('parseAndCheck rejects a non-positive / oversized max_changed_lines', () => {
  assert.equal(parseAndCheck(raw({ ...good, max_changed_lines: 0 }), CTX).ok, false);
  assert.equal(parseAndCheck(raw({ ...good, max_changed_lines: 999999 }), CTX).ok, false);
});

test('parseAndCheck rejects unparseable / non-JSON output', () => {
  assert.equal(parseAndCheck('sorry, I cannot do that', CTX).ok, false);
});

test('parseAndCheck rejects a missing field', () => {
  const { contract_md, ...missing } = good;
  const r = parseAndCheck(raw(missing), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('contract_md')));
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/core-plan.test.ts`
Expected: FAIL (cannot find `../src/core/planCheck.ts`).

- [ ] **Step 3: Implement `src/core/planCheck.ts`**

```ts
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
  const globList: string[] = Array.isArray(globs) && globs.every((g) => typeof g === 'string') ? (globs as string[]) : [];
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
```

- [ ] **Step 4: Run, expect pass**

Run: `npx tsc --noEmit && node --test test/core-plan.test.ts`
Expected: PASS (all `parseAndCheck` subtests).

- [ ] **Step 5: Verify core purity**

Run: `node scripts/check-deps.mjs`
Expected: `check:deps OK - src/core is pure.`

- [ ] **Step 6: Commit**

```bash
git add src/core/planCheck.ts test/core-plan.test.ts
git commit -m "feat(plan): pure deterministic contract validation"
```

---

### Task 3: io helpers -- tracked files + claude planner spawn

**Files:**
- Modify: `src/io/git.ts` (add `listTrackedFiles`)
- Create: `src/io/claudePlan.ts`
- Test: `test/io-plan.test.ts`

**Interfaces:**
- Produces: `listTrackedFiles(cwd: string, cap?: number): { files: string[]; truncated: boolean }` (io/git);
  `invokeClaudePlanner(prompt: string, env?: NodeJS.ProcessEnv): { ok: boolean; text: string; error?: string }` (io/claudePlan).

- [ ] **Step 1: Write the failing test** in `test/io-plan.test.ts`

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles } from '../src/io/git.ts';
import { invokeClaudePlanner } from '../src/io/claudePlan.ts';
import * as fx from '../testkit/gitRepo.ts';

test('listTrackedFiles returns git-tracked paths', () => {
  const dir = fx.initRepo();
  try {
    fx.write(dir, 'src/x.ts', 'export const x = 1;\n');
    fx.addCommit(dir, 'x');
    const r = listTrackedFiles(dir);
    assert.ok(r.files.includes('src/x.ts'));
    assert.equal(r.truncated, false);
  } finally {
    fx.cleanup(dir);
  }
});

test('invokeClaudePlanner reads the .result field of the claude json envelope', () => {
  const FAKE = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));
  const r = invokeClaudePlanner('ignored', { ...process.env, ROUTER_CLAUDE_BIN: FAKE, ROUTER_FAKE_PLAN: 'valid' });
  assert.equal(r.ok, true);
  assert.match(r.text, /"id"\s*:\s*"slugify"/);
});
```

- [ ] **Step 2: Add `listTrackedFiles` to `src/io/git.ts`** (append; `execFileSync` is already imported)

```ts
/** git-tracked files under cwd, capped to `cap` (reports truncation, never silently). */
export function listTrackedFiles(cwd: string, cap = 2000): { files: string[]; truncated: boolean } {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = out.split('\n').filter((l) => l !== '');
  return { files: all.slice(0, cap), truncated: all.length > cap };
}
```

- [ ] **Step 3: Create `src/io/claudePlan.ts`**

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

// One-shot headless claude call for planning. Unlike the executor, the planner needs
// NO file/tool permissions: it only consumes the prompt and returns text.
// `claude -p <prompt> --output-format json` prints an envelope whose `.result` is the
// assistant's final text. ROUTER_CLAUDE_BIN overrides the binary (tests).
export function invokeClaudePlanner(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; text: string; error?: string } {
  const bin = env.ROUTER_CLAUDE_BIN ?? 'claude';
  try {
    const out = execFileSync(bin, ['-p', prompt, '--output-format', 'json'], {
      encoding: 'utf8',
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    try {
      const envelope = JSON.parse(out) as { result?: unknown };
      if (typeof envelope.result === 'string') return { ok: true, text: envelope.result };
    } catch {
      // fall through: treat raw stdout as the text
    }
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, text: '', error: (e as Error).message };
  }
}
```

- [ ] **Step 4: Create `testkit/fakeClaudePlanner.mjs`**

```js
#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for `claude -p ... --output-format json`. Ignores args; prints a json
// envelope whose `.result` is a task-contract JSON string. ROUTER_FAKE_PLAN selects
// which contract: valid | badref | broad.
const good = {
  id: 'slugify',
  title: 'Implement slugify()',
  allowed_globs: ['src/**'],
  forbidden_globs: [],
  max_changed_lines: 100,
  build_ref: 'build',
  test_ref: 'test',
  contract_md: '# Implement slugify()\n\n## Goal\n\nImplement slugify.\n\n## Definition of Done\n\n- [ ] tests pass\n',
};
const mode = process.env.ROUTER_FAKE_PLAN ?? 'valid';
const contract =
  mode === 'badref' ? { ...good, build_ref: 'nope' } : mode === 'broad' ? { ...good, allowed_globs: ['**'] } : good;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(contract) }) + '\n');
process.exit(0);
```

- [ ] **Step 5: Run tests, expect pass**

Run: `chmod +x testkit/fakeClaudePlanner.mjs && npx tsc --noEmit && node --test test/io-plan.test.ts`
Expected: PASS both subtests.

- [ ] **Step 6: Commit**

```bash
git add src/io/git.ts src/io/claudePlan.ts testkit/fakeClaudePlanner.mjs test/io-plan.test.ts
git commit -m "feat(plan): io helpers for tracked files + claude planner spawn"
```

---

### Task 4: `app/plan.ts` -- compose digest + claude + check + materialize

**Files:**
- Create: `src/app/plan.ts`
- Test: `test/app-plan.test.ts`

**Interfaces:**
- Consumes: `buildPlannerPrompt`, `parseAndCheck` (core); `listTrackedFiles` (io/git), `invokeClaudePlanner` (io/claudePlan), `loadPolicyFromDisk` (app/policyLoad), `createTask` + `TransitionDeps` (app/transition), `classifyRisk` (core/risk); `RouterPaths` (io/paths).
- Produces: `runPlan(deps: TransitionDeps, goal: string, opts?: { id?: string }): PlanOutcome` where
  `PlanOutcome = { ok: true; id: string; contract: ProposedContract; risk: RiskVerdict; truncated: boolean } | { ok: false; errors: string[] }`.

- [ ] **Step 1: Write the failing test** in `test/app-plan.test.ts`

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';
import { routerPaths } from '../src/io/paths.ts';
import { systemClock } from '../src/io/clock.ts';
import { runPlan } from '../src/app/plan.ts';

const FAKE = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));

function repo() {
  const dir = fx.initRepo();
  fx.write(dir, 'src/slugify.mjs', 'export const x=1;\n');
  fx.write(dir, '.router/policy.yaml',
    'schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - ["node", "-e", "0"]\n  test:\n    - ["node", "-e", "0"]\n');
  fx.addCommit(dir, 'base');
  return dir;
}

test('runPlan materializes a DRAFT task from a valid claude proposal', () => {
  const dir = repo();
  const prev = process.env.ROUTER_CLAUDE_BIN;
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'valid';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'implement slugify');
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.id, 'slugify');
      assert.ok(existsSync(paths.taskYaml('slugify')));
      assert.match(readFileSync(paths.contractMd('slugify'), 'utf8'), /Implement slugify/);
    }
  } finally {
    if (prev === undefined) delete process.env.ROUTER_CLAUDE_BIN; else process.env.ROUTER_CLAUDE_BIN = prev;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});

test('runPlan rejects an invalid proposal without creating a task', () => {
  const dir = repo();
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'badref';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'implement slugify');
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.errors.some((e) => e.includes('build_ref')));
    assert.equal(existsSync(paths.taskDir('slugify')), false);
  } finally {
    delete process.env.ROUTER_CLAUDE_BIN;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/app-plan.test.ts`
Expected: FAIL (cannot find `../src/app/plan.ts`).

- [ ] **Step 3: Implement `src/app/plan.ts`**

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dump } from 'js-yaml';
import type { ProposedContract, RepoDigest, TaskYaml } from '../domain/types.ts';
import { buildPlannerPrompt } from '../core/planPrompt.ts';
import { parseAndCheck } from '../core/planCheck.ts';
import { classifyRisk, type RiskVerdict } from '../core/risk.ts';
import { listTrackedFiles } from '../io/git.ts';
import { invokeClaudePlanner } from '../io/claudePlan.ts';
import { loadPolicyFromDisk } from './policyLoad.ts';
import { createTask, type TransitionDeps } from './transition.ts';

export type PlanOutcome =
  | { ok: true; id: string; contract: ProposedContract; risk: RiskVerdict; truncated: boolean }
  | { ok: false; errors: string[] };

const README_HEAD_LINES = 40;

function readReadmeHead(repoRoot: string): string | undefined {
  const p = `${repoRoot}/README.md`;
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8').split('\n').slice(0, README_HEAD_LINES).join('\n');
}

function renderTaskYaml(c: ProposedContract): string {
  const task: TaskYaml = {
    schema_version: 1,
    id: c.id,
    title: c.title,
    base_sha: null,
    max_wall_minutes: 30,
    allowed_globs: c.allowed_globs,
    forbidden_globs: c.forbidden_globs,
    max_changed_lines: c.max_changed_lines,
    build_ref: c.build_ref,
    test_ref: c.test_ref,
    verification_params: {},
  };
  return dump(task, { lineWidth: 120 });
}

export function runPlan(deps: TransitionDeps, goal: string, opts: { id?: string } = {}): PlanOutcome {
  const { paths } = deps;
  const policy = loadPolicyFromDisk(paths);
  const policyRefs = Object.keys(policy.verification);
  const tracked = listTrackedFiles(paths.repoRoot);
  const readmeHead = readReadmeHead(paths.repoRoot);
  const digest: RepoDigest = {
    files: tracked.files,
    truncated: tracked.truncated,
    verificationRefs: policyRefs,
    ...(readmeHead !== undefined ? { readmeHead } : {}),
  };

  const res = invokeClaudePlanner(buildPlannerPrompt(digest, goal), process.env);
  if (!res.ok) return { ok: false, errors: [`claude planner failed: ${res.error ?? 'unknown error'}`] };

  const checked = parseAndCheck(res.text, { policyRefs, trackedFiles: tracked.files });
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const contract = checked.contract;
  const id = opts.id ?? contract.id;
  createTask(deps, id, contract.title); // registers DRAFT
  writeFileSync(paths.taskYaml(id), renderTaskYaml(contract));
  writeFileSync(paths.contractMd(id), contract.contract_md);

  return { ok: true, id, contract, risk: classifyRisk(contract.allowed_globs), truncated: tracked.truncated };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx tsc --noEmit && node --test test/app-plan.test.ts`
Expected: PASS both subtests.

- [ ] **Step 5: Commit**

```bash
git add src/app/plan.ts test/app-plan.test.ts
git commit -m "feat(plan): app runPlan composes digest + planner + validation + materialize"
```

---

### Task 5: CLI `plan` verb (+ `--execute` chaining)

**Files:**
- Modify: `src/cli/commands.ts` (import, `plan` handler, HANDLERS, help)
- Test: `test/cli-plan.test.ts`

**Interfaces:**
- Consumes: `runPlan` (app/plan); existing `validate`, `queue`, `run` handlers (same module); `depsFor`, `emit`, `CliError`, `flagBool`, `flagStr`.
- Produces: `plan` handler registered under key `plan`.

- [ ] **Step 1: Write the failing e2e test** in `test/cli-plan.test.ts`

```ts
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_PLANNER = fileURLToPath(new URL('../testkit/fakeClaudePlanner.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir, argv, envExtra = {}) {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function repo() {
  const dir = fx.initRepo();
  fx.write(dir, 'src/slugify.mjs', 'export const x=1;\n');
  fx.write(dir, '.router/policy.yaml',
    'schema_version: 1\nworker:\n  kind: codex\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - ["node", "-e", "0"]\n  test:\n    - ["node", "-e", "0"]\n');
  fx.addCommit(dir, 'base');
  return dir;
}

test('router plan materializes a DRAFT task from a valid proposal', () => {
  chmodSync(FAKE_PLANNER, 0o755);
  const dir = repo();
  try {
    const r = router(dir, ['plan', 'implement slugify', '--json'], { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'valid' });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out);
    assert.equal(out.id, 'slugify');
    const st = JSON.parse(router(dir, ['status', 'slugify', '--json']).out);
    assert.equal(st.state, 'DRAFT');
  } finally {
    fx.cleanup(dir);
  }
});

test('router plan rejects a broad-scope proposal and creates no task', () => {
  chmodSync(FAKE_PLANNER, 0o755);
  const dir = repo();
  try {
    const r = router(dir, ['plan', 'do everything'], { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'broad' });
    assert.equal(r.code, 1);
    assert.match(r.out, /too broad/);
    assert.equal(existsSync(`${dir}/.router/tasks/slugify`), false);
  } finally {
    fx.cleanup(dir);
  }
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/cli-plan.test.ts`
Expected: FAIL (`plan` is not a known command).

- [ ] **Step 3: Add the import** to `src/cli/commands.ts` (next to the other `app/` imports)

```ts
import { runPlan } from '../app/plan.ts';
```

- [ ] **Step 4: Add the `plan` handler** to `src/cli/commands.ts` (place it just before `const selftestCmd`)

```ts
const plan: Handler = async (ctx) => {
  const { deps } = depsFor(ctx);
  const goal = flagStr(ctx.args.flags, 'goal') ?? ctx.args.positionals[0];
  if (goal === undefined || goal.trim() === '') throw new CliError('usage: router plan "<goal>"', 2);
  const idFlag = flagStr(ctx.args.flags, 'id');
  const outcome = runPlan(deps, goal, idFlag !== undefined ? { id: idFlag } : {});
  if (!outcome.ok) throw new CliError(`plan rejected:\n  - ${outcome.errors.join('\n  - ')}`, 1);

  const id = outcome.id;
  if (!flagBool(ctx.args.flags, 'execute')) {
    emit(ctx.json, { ok: true, id, state: 'DRAFT', risk: outcome.risk.level, reasons: outcome.risk.reasons, truncated: outcome.truncated }, () =>
      `planned ${id} (DRAFT, risk ${outcome.risk.level}); review .router/tasks/${id}/, then \`router validate ${id}\` or re-run with --execute`,
    );
    return 0;
  }
  // --execute: chain the existing pipeline (each owns its own gates).
  const chainCtx: Ctx = { ...ctx, args: { ...ctx.args, flags: { ...ctx.args.flags, id } } };
  validate(chainCtx);
  queue(chainCtx);
  return await run(chainCtx);
};
```

- [ ] **Step 5: Register in `HANDLERS` and update help** in `src/cli/commands.ts`

Add `plan,` to the `HANDLERS` object (near `run`), and in `helpText()` add `plan` to the Lifecycle line and `--execute`, `--goal` to the Flags line:

```ts
    `Lifecycle:  init * new * plan * validate * queue * run * status * result * approve * merge\n` +
```
and append `--execute` to the flags listing.

- [ ] **Step 6: Run, expect pass**

Run: `npx tsc --noEmit && node --test test/cli-plan.test.ts`
Expected: PASS both subtests.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands.ts test/cli-plan.test.ts
git commit -m "feat(plan): router plan CLI verb with --execute chaining"
```

---

### Task 6: `--execute` end-to-end + docs + gate + bundle

**Files:**
- Test: `test/cli-plan.test.ts` (extend with the `--execute` path)
- Modify: `README.md`, `docs/quickstart.md`
- Regenerate: `dist/router.js`

**Interfaces:** none new.

- [ ] **Step 1: Add the `--execute` e2e test** to `test/cli-plan.test.ts`

```ts
import { join } from 'node:path';
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('router plan --execute runs the pipeline to PASSED', async () => {
  chmodSync(FAKE_PLANNER, 0o755);
  chmodSync(FAKE_CODEX, 0o755);
  // fakeCodex edits src/a.ts; make the proposal + verification align with that.
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.router/policy.yaml',
    `schema_version: 1\nworker:\n  kind: codex\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`);
  fx.addCommit(dir, 'base');
  try {
    const r = router(dir, ['plan', 'edit a', '--execute', '--json'],
      { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'valid', ROUTER_CODEX_BIN: FAKE_CODEX });
    assert.equal(r.code, 0);
    // poll to terminal
    let state = 'RUNNING';
    for (let i = 0; i < 40; i++) {
      state = JSON.parse(router(dir, ['status', 'slugify', '--json']).out).state;
      if (['PASSED', 'FAILED'].includes(state)) break;
      await sleep(200);
    }
    assert.equal(state, 'PASSED', `expected PASSED, got ${state}`);
  } finally {
    fx.cleanup(dir);
  }
});
```

Note: `fakeCodex.mjs` edits `src/a.ts`; the `valid` fake proposal's `allowed_globs` is `src/**`, which covers it. If the fake proposal id (`slugify`) needs to match, poll by that id.

- [ ] **Step 2: Run the full plan test file, expect pass**

Run: `node --test test/cli-plan.test.ts`
Expected: PASS all three subtests.

- [ ] **Step 3: Document `plan` in `docs/quickstart.md`** -- add a short section after step 2:

```markdown
### Shortcut: let claude draft the contract

`router plan "<goal>"` asks claude to propose a task contract, validates it, and
writes it at DRAFT for you to review:

    router plan "implement slugify() in src/"        # writes .router/tasks/<id>/
    router validate <id> && router queue <id> && router run <id>
    # or, to chain it in one shot once you trust the setup:
    router plan "implement slugify() in src/" --execute

claude only proposes the contract; router rejects a malformed or over-broad
proposal (e.g. a bare `**` scope) before anything runs.
```

- [ ] **Step 4: Add `plan` to `README.md`** -- one line in the command list mentioning `router plan "<goal>"` drafts + validates a contract via claude.

- [ ] **Step 5: Full gate**

Run: `npm run check`
Expected: `# fail 0`, check:deps OK.

- [ ] **Step 6: Rebuild the bundle + selftest**

Run: `npm run build && node dist/router.js selftest`
Expected: `built dist/router.js`, then `selftest PASSED`.

- [ ] **Step 7: Commit**

```bash
git add test/cli-plan.test.ts docs/quickstart.md README.md dist/router.js
git commit -m "feat(plan): --execute e2e, docs, rebuilt bundle"
```

---

## Self-Review

**Spec coverage:**
- `router plan` verb, single task, static digest, stop-at-DRAFT + `--execute` -- Tasks 4-5. 
- Core invariant (claude only proposes; deterministic validation gates) -- Task 2 (`parseAndCheck`), scope-broadness + ref + glob-match checks. 
- Rings/purity (planPrompt/planCheck pure; io spawn/git; app compose; cli verb) -- Tasks 1-5, purity check in Task 2 Step 5. 
- Error handling (bad output -> exit 1 no task; missing claude -> error; truncation surfaced) -- Task 4 `runPlan` + Task 5 handler + `truncated` in outcome. 
- Testing (pure units + fake-bin app/CLI; no real claude) -- Tasks 1-6. 
- Out-of-scope (multi-task, retry, agentic) -- not implemented. 

**Placeholder scan:** no TBD/TODO; all code shown in full. 

**Type consistency:** `ProposedContract`/`RepoDigest`/`PlanCheckResult` defined in Task 1 and used identically in Tasks 2/4; `runPlan` signature in Task 4 matches its call in Task 5; `invokeClaudePlanner`/`listTrackedFiles` signatures in Task 3 match Task 4 usage; `matchGlob` (core/glob.ts) and `classifyRisk` (core/risk.ts) reused with their real signatures. 

**Deviation from spec:** chaining flag is `--execute` (not `--run`, which is an existing value flag) -- noted in Global Constraints.
