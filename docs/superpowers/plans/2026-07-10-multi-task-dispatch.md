# Multi-task Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `router plan` decomposes a goal into 1..N tasks; clear tasks are dispatched to a policy-mapped cheap executor, unclear tasks are handed back to the main session; dependent tasks are gated until their dependencies are MERGED; a new `router ready` lists runnable tasks.

**Architecture:** The planner LLM emits only labeled artifacts (`clarity`, `depends_on`); pure core validates the batch (per-task checks + DAG); app materializes clear tasks (writing the tier-mapped `worker` into the frozen contract) and reports unclear ones; the dependency gate is a deterministic `startRun` guard. Spec: `docs/superpowers/specs/2026-07-10-multi-task-dispatch-design.md`.

**Tech Stack:** TypeScript on Node 22 (native type-stripping), `node:test`, `js-yaml`, esbuild bundle to committed `dist/router.js`.

## Global Constraints

- Node 22 type-stripping: relative imports end in `.ts`; NO `enum` / parameter properties / `namespace`.
- `exactOptionalPropertyTypes: true` -- never assign `undefined` to an optional property; use conditional spread `{...(v !== undefined ? { k: v } : {})}`.
- Rings: `domain -> core -> io -> app -> cli`; `src/core/**` PURE (no fs/child_process/process/clock/random; may not import io/app/cli) -- enforced by `scripts/check-deps.mjs`.
- ASCII only. New files start with the two-line Apache-2.0 SPDX header.
- Commits: NO `Co-Authored-By` line.
- Gate: `npm run check` green; `npm run build` regenerates committed `dist/router.js`; `node dist/router.js selftest` prints `selftest PASSED`.
- main is branch-protected: all work on branch `feat-multi-task-dispatch`, merged via PR with CI green.

---

### Task 1: Domain types + schemas

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `schema/task_contract.schema.json`
- Modify: `schema/policy.schema.json`

**Interfaces:**
- Produces: `ProposedTask`, `HandbackItem`, `PlanBatchResult` (domain); `TaskYaml.depends_on?/worker?`; `Policy.tiers?`.

- [ ] **Step 1: Extend `src/domain/types.ts`.** In `TaskYaml`, after `verification_params?`:

```ts
  /** Task ids that must be MERGED before this task may run (deterministic gate). */
  depends_on?: string[];
  /** Executor pinned at plan time (tier mapping); head of the run's fallback chain. */
  worker?: WorkerPolicy;
```

In `Policy`, after `secret_scan?`:

```ts
  /** Tier mapping for dispatch: which executor runs planner-labeled "clear" tasks. */
  tiers?: { clear?: WorkerPolicy };
```

After the `PlanCheckResult` type, add:

```ts
/** One task in a planner batch: contract fields + dispatch labels. */
export type ProposedTask = ProposedContract & {
  clarity: 'clear' | 'unclear';
  depends_on: string[];
};

/** An unclear task returned to the main session instead of being dispatched. */
export interface HandbackItem {
  id: string;
  title: string;
  reason?: string;
  depends_on: string[];
}

export type PlanBatchResult =
  | { ok: true; tasks: ProposedTask[]; handback: HandbackItem[] }
  | { ok: false; errors: string[] };
```

- [ ] **Step 2: Extend `schema/task_contract.schema.json`.** Add to `properties` (keep `additionalProperties: false`):

```json
    "depends_on": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    },
    "worker": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": { "enum": ["codex", "claude"] },
        "api_key_env": { "type": "string", "minLength": 1 },
        "model": { "type": "string", "minLength": 1 },
        "max_wall_minutes_default": { "type": "integer", "minimum": 1 },
        "stall_minutes": { "type": "integer", "minimum": 1 }
      }
    }
```

- [ ] **Step 3: Extend `schema/policy.schema.json`.** Add to top-level `properties`:

```json
    "tiers": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "clear": { "$ref": "#/definitions/worker" }
      }
    }
```

- [ ] **Step 4: Verify + commit**

Run: `npm run check`
Expected: `# fail 0` (types/schemas are additive).

```bash
git add src/domain/types.ts schema/task_contract.schema.json schema/policy.schema.json
git commit -m "feat(dispatch): domain types + schemas for clarity/depends_on/tiers"
```

---

### Task 2: Multi-task planner prompt (pure)

**Files:**
- Modify: `src/core/planPrompt.ts`
- Modify: `test/core-plan.test.ts` (prompt tests)

**Interfaces:**
- `buildPlannerPrompt(digest, goal)` signature unchanged; output text now requests a `{"tasks":[...]}` batch.

- [ ] **Step 1: Update the prompt test.** In `test/core-plan.test.ts` replace the prompt test body:

```ts
test('buildPlannerPrompt asks for a task batch with clarity and depends_on', () => {
  const p = buildPlannerPrompt(digest, 'make a() faster');
  assert.match(p, /make a\(\) faster/);
  assert.match(p, /build, test/); // the legal verification refs
  assert.match(p, /src\/a\.ts/); // repo files
  assert.match(p, /bare "\*\*"/); // the scope constraint is stated
  assert.match(p, /"tasks"/); // batch envelope
  assert.match(p, /clarity/);
  assert.match(p, /depends_on/);
});
```

- [ ] **Step 2: Run to see it fail** -- `node --test test/core-plan.test.ts` -> the new assertions fail.

- [ ] **Step 3: Rewrite the prompt body in `src/core/planPrompt.ts`** (same signature, new text):

```ts
export function buildPlannerPrompt(digest: RepoDigest, goal: string): string {
  const refs = digest.verificationRefs.join(', ');
  const lines = [
    'You are a planning assistant for a deterministic coding-task router.',
    'Decompose the GOAL into the SMALLEST set of tasks (1..N; one task is fine).',
    'Respond with ONLY a single JSON object -- no prose, no markdown, no code fences:',
    '{ "tasks": [ <task>, ... ] }',
    '',
    'Each <task> has:',
    '  "id": "kebab-case-slug", "title": "short imperative title",',
    '  "clarity": "clear" | "unclear",',
    '  "depends_on": ["ids of tasks in THIS response that must merge first"],',
    'and, when clarity is "clear" (well-bounded, mechanically checkable):',
    '  "allowed_globs": ["smallest set of path globs"], "forbidden_globs": [],',
    `  "max_changed_lines": 100, "build_ref": "one of: ${refs}", "test_ref": "one of: ${refs}",`,
    '  "contract_md": "markdown with a Goal section and a Definition of Done checklist"',
    'or, when clarity is "unclear" (needs human judgment/design first):',
    '  "reason": "what must be clarified before this can be dispatched"',
    '',
    'Constraints:',
    '- Mark a task "clear" ONLY if an average model could finish it from the contract alone.',
    '- allowed_globs must be minimal and match existing files; never use a bare "**".',
    '- build_ref and test_ref MUST be chosen from the list above.',
    '- depends_on may only reference ids in this same response; no cycles.',
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

- [ ] **Step 4: Run + commit**

Run: `node --test test/core-plan.test.ts` -> prompt tests PASS (batch-check tests come next task).

```bash
git add src/core/planPrompt.ts test/core-plan.test.ts
git commit -m "feat(dispatch): planner prompt requests a labeled task batch"
```

---

### Task 3: Batch validation (pure core)

**Files:**
- Modify: `src/core/planCheck.ts`
- Modify: `test/core-plan.test.ts`

**Interfaces:**
- Produces: `parseAndCheckBatch(rawText, ctx): PlanBatchResult`. Existing `parseAndCheck` (single) stays, reimplemented on the shared per-task checker.

- [ ] **Step 1: Write failing tests** (append to `test/core-plan.test.ts`; `raw`, `good`, `CTX` already exist):

```ts
import { parseAndCheckBatch } from '../src/core/planCheck.ts';

const clearA = { ...good, id: 'task-a', clarity: 'clear', depends_on: [] };
const clearB = { ...good, id: 'task-b', clarity: 'clear', depends_on: ['task-a'] };
const unclearC = { id: 'task-c', title: 'Design the API', clarity: 'unclear', reason: 'shape unknown' };

test('parseAndCheckBatch accepts a batch and splits clear vs handback', () => {
  const r = parseAndCheckBatch(raw({ tasks: [clearA, clearB, unclearC] }), CTX);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.tasks.map((t) => t.id), ['task-a', 'task-b']);
    assert.deepEqual(r.tasks[1]!.depends_on, ['task-a']);
    assert.deepEqual(r.handback.map((h) => h.id), ['task-c']);
    assert.equal(r.handback[0]!.reason, 'shape unknown');
  }
});

test('parseAndCheckBatch treats a bare single task object as one clear task', () => {
  const r = parseAndCheckBatch(raw(good), CTX);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0]!.clarity, 'clear');
    assert.deepEqual(r.tasks[0]!.depends_on, []);
  }
});

test('parseAndCheckBatch rejects duplicate ids', () => {
  const r = parseAndCheckBatch(raw({ tasks: [clearA, { ...clearB, id: 'task-a' }] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('duplicate')));
});

test('parseAndCheckBatch rejects a dep on an id not in the batch', () => {
  const r = parseAndCheckBatch(raw({ tasks: [{ ...clearA, depends_on: ['ghost'] }] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('ghost')));
});

test('parseAndCheckBatch rejects a dependency cycle', () => {
  const a = { ...clearA, depends_on: ['task-b'] };
  const r = parseAndCheckBatch(raw({ tasks: [a, clearB] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('cycle')));
});

test('parseAndCheckBatch rejects a bad clarity literal', () => {
  const r = parseAndCheckBatch(raw({ tasks: [{ ...clearA, clarity: 'maybe' }] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('clarity')));
});

test('parseAndCheckBatch still applies full contract checks to clear tasks', () => {
  const r = parseAndCheckBatch(raw({ tasks: [{ ...clearA, build_ref: 'nope' }] }), CTX);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('build_ref')));
});

test('parseAndCheckBatch allows a clear task to depend on an unclear one', () => {
  const b = { ...clearB, depends_on: ['task-c'] };
  const r = parseAndCheckBatch(raw({ tasks: [b, unclearC] }), CTX);
  assert.equal(r.ok, true); // the run gate simply stays unmet until task-c exists and merges
});
```

- [ ] **Step 2: Run to see them fail** -- `node --test test/core-plan.test.ts`.

- [ ] **Step 3: Implement in `src/core/planCheck.ts`.** Refactor: extract the existing field checks of `parseAndCheck` into a helper, then add the batch entry point. Replace the body after `extractJsonObject` as follows (keep `extractJsonObject`, constants, `PlanCheckContext` as-is; add imports for the new types):

```ts
import type { HandbackItem, PlanBatchResult, PlanCheckResult, ProposedContract, ProposedTask } from '../domain/types.ts';
```

```ts
// Field checks for one CLEAR task object; returns the contract or errors.
function checkContractFields(obj: Record<string, unknown>, ctx: PlanCheckContext, label: string): { contract?: ProposedContract; errors: string[] } {
  const errors: string[] = [];
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

  if (!ID_RE.test(str('id'))) errors.push(`${label}: id must be a kebab-case slug`);
  if (str('title').trim() === '') errors.push(`${label}: title must be a non-empty string`);
  if (str('contract_md').trim() === '') errors.push(`${label}: contract_md must be a non-empty string`);

  const globs = obj['allowed_globs'];
  const globList: string[] =
    Array.isArray(globs) && globs.every((g) => typeof g === 'string') ? (globs as string[]) : [];
  if (globList.length === 0) errors.push(`${label}: allowed_globs must be a non-empty string array`);
  for (const g of globList) {
    if (BROAD.has(g.trim())) errors.push(`${label}: allowed_glob '${g}' is too broad`);
    else if (!ctx.trackedFiles.some((f) => matchGlob(f, g))) errors.push(`${label}: allowed_glob '${g}' matches no tracked file`);
  }

  for (const ref of ['build_ref', 'test_ref']) {
    const v = str(ref);
    if (v === '') errors.push(`${label}: ${ref} must be a non-empty string`);
    else if (!ctx.policyRefs.includes(v)) errors.push(`${label}: ${ref} '${v}' not in policy.verification (${ctx.policyRefs.join(', ')})`);
  }

  const mcl = obj['max_changed_lines'];
  if (typeof mcl !== 'number' || !Number.isInteger(mcl) || mcl <= 0) errors.push(`${label}: max_changed_lines must be a positive integer`);
  else if (mcl > MAX_CHANGED_LINES_CEILING) errors.push(`${label}: max_changed_lines ${mcl} exceeds ceiling ${MAX_CHANGED_LINES_CEILING}`);

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
  const entries: Record<string, unknown>[] = Array.isArray(root['tasks'])
    ? (root['tasks'] as unknown[]).map((t) => (typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}))
    : [root];
  const bare = !Array.isArray(root['tasks']);
  if (entries.length === 0) return { ok: false, errors: ['planner returned an empty task list'] };

  const errors: string[] = [];
  const tasks: ProposedTask[] = [];
  const handback: HandbackItem[] = [];
  const ids: string[] = [];

  for (const [i, obj] of entries.entries()) {
    const id = typeof obj['id'] === 'string' ? (obj['id'] as string) : `#${i}`;
    const label = `task ${id}`;
    ids.push(id);
    const clarity = bare ? 'clear' : obj['clarity'];
    if (clarity !== 'clear' && clarity !== 'unclear') {
      errors.push(`${label}: clarity must be "clear" or "unclear"`);
      continue;
    }
    const depends_on = strList(obj['depends_on']);
    if (clarity === 'unclear') {
      if (!ID_RE.test(id)) errors.push(`${label}: id must be a kebab-case slug`);
      const title = typeof obj['title'] === 'string' ? (obj['title'] as string) : '';
      if (title.trim() === '') errors.push(`${label}: title must be a non-empty string`);
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
  // Cycle detection (iterative DFS over the batch graph).
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
```

Then reimplement the single-task `parseAndCheck` on the helper (keeps its exported signature and existing tests):

```ts
export function parseAndCheck(rawText: string, ctx: PlanCheckContext): PlanCheckResult {
  const jsonText = extractJsonObject(rawText);
  if (jsonText === null) return { ok: false, errors: ['no JSON object found in planner output'] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`planner output is not valid JSON: ${(e as Error).message}`] };
  }
  const checked = checkContractFields(obj, ctx, 'task');
  if (checked.contract === undefined)
    return { ok: false, errors: checked.errors.map((e) => e.replace(/^task: /, '')) };
  return { ok: true, contract: checked.contract };
}
```

Note: the old single-task error strings had no `task: ` prefix; the `.replace` keeps the existing tests passing. If any existing assertion still fails on exact text, adjust the assertion to `includes` (they already use `includes`).

- [ ] **Step 4: Run + purity + commit**

Run: `npx tsc --noEmit && node --test test/core-plan.test.ts && node scripts/check-deps.mjs`
Expected: all PASS; core pure.

```bash
git add src/core/planCheck.ts test/core-plan.test.ts
git commit -m "feat(dispatch): pure batch validation with clarity split + DAG checks"
```

---

### Task 4: Batch materialization + tiering + handback (app)

**Files:**
- Modify: `src/app/plan.ts`
- Modify: `testkit/fakeClaudePlanner.mjs`
- Modify: `test/app-plan.test.ts`

**Interfaces:**
- Produces: `runPlan(deps, goal, opts?): PlanOutcome` where

```ts
export interface PlannedTaskInfo { id: string; title: string; risk: RiskVerdict; depends_on: string[] }
export type PlanOutcome =
  | { ok: true; created: PlannedTaskInfo[]; handback: HandbackItem[]; truncated: boolean }
  | { ok: false; errors: string[] };
```

- [ ] **Step 1: Extend `testkit/fakeClaudePlanner.mjs`.** Add batch modes (keep valid/badref/broad emitting the bare single object):

```js
const taskA = { ...good, id: 'task-a', clarity: 'clear', depends_on: [] };
const taskB = {
  ...good,
  id: 'task-b',
  title: 'Follow-up on task-a',
  clarity: 'clear',
  depends_on: ['task-a'],
  contract_md: '# Follow-up\n\n## Goal\n\nBuild on task-a.\n\n## Definition of Done\n\n- [ ] done\n',
};
const taskC = { id: 'task-c', title: 'Design the API shape', clarity: 'unclear', reason: 'API shape needs a human decision' };
```

and in the mode switch:

```js
const payload =
  mode === 'multi'
    ? { tasks: [taskA, taskB, taskC] }
    : mode === 'badref'
      ? { ...good, build_ref: 'nope' }
      : mode === 'broad'
        ? { ...good, allowed_globs: ['**'] }
        : good;
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(payload) }) + '\n');
```

- [ ] **Step 2: Write failing tests** (append to `test/app-plan.test.ts`; `repo()`/`FAKE` exist). Also update the two existing assertions that use `out.id` / `out.contract`: they become `out.created[0].id` etc.

```ts
test('runPlan materializes a batch: clear tasks at DRAFT with deps/worker, unclear handed back', () => {
  const dir = repo();
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'multi';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'big goal');
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.deepEqual(out.created.map((c) => c.id), ['task-a', 'task-b']);
      assert.deepEqual(out.created[1]!.depends_on, ['task-a']);
      assert.deepEqual(out.handback.map((h) => h.id), ['task-c']);
      const taskB = readFileSync(paths.taskYaml('task-b'), 'utf8');
      assert.match(taskB, /depends_on:/);
      assert.match(taskB, /task-a/);
    }
  } finally {
    delete process.env.ROUTER_CLAUDE_BIN;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});

test('runPlan writes the tier worker into clear tasks when policy.tiers.clear is set', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/slugify.mjs', 'export const x=1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    'schema_version: 1\nworker:\n  kind: codex\ntiers:\n  clear:\n    kind: claude\n    model: sonnet\nscope:\n  max_changed_lines: 400\nverification:\n  build:\n    - ["node", "-e", "0"]\n  test:\n    - ["node", "-e", "0"]\n',
  );
  fx.addCommit(dir, 'base');
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'valid';
  try {
    const paths = routerPaths(`${dir}/.router`);
    const out = runPlan({ paths, clock: systemClock }, 'implement slugify');
    assert.equal(out.ok, true);
    const y = readFileSync(paths.taskYaml('slugify'), 'utf8');
    assert.match(y, /worker:/);
    assert.match(y, /kind: claude/);
    assert.match(y, /model: sonnet/);
  } finally {
    delete process.env.ROUTER_CLAUDE_BIN;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});

test('runPlan rejects the whole batch when a task id already exists', () => {
  const dir = repo();
  process.env.ROUTER_CLAUDE_BIN = FAKE;
  process.env.ROUTER_FAKE_PLAN = 'multi';
  try {
    const paths = routerPaths(`${dir}/.router`);
    assert.equal(runPlan({ paths, clock: systemClock }, 'first').ok, true);
    const again = runPlan({ paths, clock: systemClock }, 'again');
    assert.equal(again.ok, false);
    if (!again.ok) assert.ok(again.errors.some((e) => e.includes('already exists')));
  } finally {
    delete process.env.ROUTER_CLAUDE_BIN;
    delete process.env.ROUTER_FAKE_PLAN;
    fx.cleanup(dir);
  }
});
```

- [ ] **Step 3: Run to see them fail**, then rewrite `src/app/plan.ts` (same file, new body):

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dump } from 'js-yaml';
import type { HandbackItem, ProposedTask, RepoDigest, TaskYaml, WorkerPolicy } from '../domain/types.ts';
import { buildPlannerPrompt } from '../core/planPrompt.ts';
import { parseAndCheckBatch } from '../core/planCheck.ts';
import { classifyRisk, type RiskVerdict } from '../core/risk.ts';
import { listTrackedFiles } from '../io/git.ts';
import { invokeClaudePlanner } from '../io/claudePlan.ts';
import * as store from '../io/store.ts';
import { loadPolicyFromDisk } from './policyLoad.ts';
import { createTask, type TransitionDeps } from './transition.ts';

export interface PlannedTaskInfo {
  id: string;
  title: string;
  risk: RiskVerdict;
  depends_on: string[];
}
export type PlanOutcome =
  | { ok: true; created: PlannedTaskInfo[]; handback: HandbackItem[]; truncated: boolean }
  | { ok: false; errors: string[] };

const README_HEAD_LINES = 40;

function readReadmeHead(repoRoot: string): string | undefined {
  const p = `${repoRoot}/README.md`;
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8').split('\n').slice(0, README_HEAD_LINES).join('\n');
}

function renderTaskYaml(t: ProposedTask, tierWorker: WorkerPolicy | undefined): string {
  const task: TaskYaml = {
    schema_version: 1,
    id: t.id,
    title: t.title,
    base_sha: null,
    max_wall_minutes: 30,
    allowed_globs: t.allowed_globs,
    forbidden_globs: t.forbidden_globs,
    max_changed_lines: t.max_changed_lines,
    build_ref: t.build_ref,
    test_ref: t.test_ref,
    verification_params: {},
    ...(t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
    ...(tierWorker !== undefined ? { worker: tierWorker } : {}),
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

  const checked = parseAndCheckBatch(res.text, { policyRefs, trackedFiles: tracked.files });
  if (!checked.ok) return { ok: false, errors: checked.errors };

  // --id only makes sense for a single-task plan.
  if (opts.id !== undefined && checked.tasks.length !== 1) {
    return { ok: false, errors: [`--id is only valid for a single-task plan (planner returned ${checked.tasks.length})`] };
  }
  const tasks = opts.id !== undefined ? [{ ...checked.tasks[0]!, id: opts.id }] : checked.tasks;

  // All-or-nothing: refuse the batch if any id already exists (no partial batches).
  const clash = tasks.filter((t) => store.readState(paths, t.id) !== null).map((t) => t.id);
  if (clash.length > 0) return { ok: false, errors: clash.map((id) => `task '${id}' already exists`) };

  const tierWorker = policy.tiers?.clear;
  const created: PlannedTaskInfo[] = [];
  for (const t of tasks) {
    createTask(deps, t.id, t.title); // registers DRAFT
    writeFileSync(paths.taskYaml(t.id), renderTaskYaml(t, tierWorker));
    writeFileSync(paths.contractMd(t.id), t.contract_md);
    created.push({ id: t.id, title: t.title, risk: classifyRisk(t.allowed_globs), depends_on: t.depends_on });
  }
  return { ok: true, created, handback: checked.handback, truncated: tracked.truncated };
}
```

- [ ] **Step 4: Fix the two pre-existing app-plan tests** to the new outcome shape (`out.created[0].id === 'slugify'`; the reject test asserts unchanged).

- [ ] **Step 5: Run + commit**

Run: `npx tsc --noEmit && node --test test/app-plan.test.ts`
Expected: PASS all.

```bash
git add src/app/plan.ts testkit/fakeClaudePlanner.mjs test/app-plan.test.ts
git commit -m "feat(dispatch): batch materialization with tier mapping + handback"
```

---

### Task 5: Dependency gate + per-task worker chain head

**Files:**
- Modify: `src/app/worker.ts`
- Modify: `src/cli/commands.ts` (run handler catch + `_worker-run` chain)
- Modify: `test/app-worker.test.ts`

**Interfaces:**
- Produces: `DependencyError` (exported from `src/app/worker.ts`); `startRun` refuses tasks with unmet `depends_on`; `_worker-run` puts `task.worker` at the chain head.

- [ ] **Step 1: Write the failing gate test** (append to `test/app-worker.test.ts`, following that file's existing fixture style for creating a QUEUED task; the essential assertions):

```ts
// task 'dep-child' declares depends_on: ['dep-parent']; dep-parent is not MERGED.
assert.throws(
  () => startRun(deps, 'dep-child'),
  (e: Error) => e.name === 'DependencyError' && /dep-parent/.test(e.message),
);
```

(Concretely: scaffold two tasks with the file fixtures used by the existing startRun tests, hand-edit `dep-child`'s task.yaml to add `depends_on: ['dep-parent']`, validate+queue both, then assert the throw. After transitioning `dep-parent` to MERGED via the test's transition helper, `startRun(deps, 'dep-child')` succeeds.)

- [ ] **Step 2: Implement the gate in `src/app/worker.ts`.** Add next to `CapExceededError`:

```ts
export class DependencyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DependencyError';
  }
}
```

In `startRun`, replace the single `loadTask` usage (`const maxWallMinutes = loadTask(paths, id).task.max_wall_minutes;`) with:

```ts
  const { task: taskYaml } = loadTask(paths, id);
  const maxWallMinutes = taskYaml.max_wall_minutes;

  // Dependency gate: every depends_on must already be MERGED (deterministic).
  const unmet = (taskYaml.depends_on ?? []).filter((d) => currentState(paths, d)?.state !== 'MERGED');
  if (unmet.length > 0) {
    throw new DependencyError(`unmet dependencies (must be MERGED first): ${unmet.join(', ')}`);
  }
```

- [ ] **Step 3: Translate it in the `run` handler** (`src/cli/commands.ts`), alongside the caps catch:

```ts
    if (e instanceof CapExceededError) throw new CliError(`refused: ${e.message}`, 1);
    if (e instanceof DependencyError) throw new CliError(`blocked: ${e.message}`, 1);
```

(and add `DependencyError` to the import from `../app/worker.ts`).

- [ ] **Step 4: Per-task worker at the chain head** in the `_worker-run` handler (`src/cli/commands.ts`). The handler already loads `policy` and computes `workers`; it also already branches for the rescue attempt. In the non-rescue branch, replace:

```ts
    const { ordered } = planExecutorOrder(paths, Date.parse(deps.clock.nowIso()), policy, workers);
    launchers = ordered.map(makeLauncher);
```

with:

```ts
    const { ordered } = planExecutorOrder(paths, Date.parse(deps.clock.nowIso()), policy, workers);
    // A tier-pinned task worker leads the chain; the policy chain stays as fallbacks.
    const pinned = loadTask(paths, id).task.worker;
    const chain =
      pinned !== undefined
        ? [pinned, ...ordered.filter((w) => !(w.kind === pinned.kind && w.model === pinned.model))]
        : ordered;
    launchers = chain.map(makeLauncher);
```

- [ ] **Step 5: Add a worker-pin test** (append to `test/app-plan.test.ts` or the cli e2e in Task 6 -- the e2e proves it end-to-end; a unit assertion that `renderTaskYaml` wrote `worker:` already exists from Task 4, so the chain-head logic is covered by the Task 6 e2e).

- [ ] **Step 6: Run + commit**

Run: `npm run check`
Expected: `# fail 0`.

```bash
git add src/app/worker.ts src/cli/commands.ts test/app-worker.test.ts
git commit -m "feat(dispatch): dependency gate in startRun + tier-pinned worker at chain head"
```

---

### Task 6: CLI -- plan batch output, `ready` verb, wave e2e

**Files:**
- Modify: `src/cli/commands.ts` (plan handler, new `ready`, HANDLERS, help)
- Modify: `test/cli-plan.test.ts`

**Interfaces:**
- `plan` emits `{ok, created:[{id,title,risk,depends_on}], handback, truncated}`; `--execute` validates+queues ALL created tasks and runs the ready ones.
- `ready` lists QUEUED tasks whose deps are all MERGED (plus what blocks the rest).

- [ ] **Step 1: Rewrite the `plan` handler:**

```ts
const plan: Handler = async (ctx) => {
  const { deps, paths } = depsFor(ctx);
  const goal = flagStr(ctx.args.flags, 'goal') ?? ctx.args.positionals[0];
  if (goal === undefined || goal.trim() === '') throw new CliError('usage: router plan "<goal>"', 2);
  const idFlag = flagStr(ctx.args.flags, 'id');
  const outcome = runPlan(deps, goal, idFlag !== undefined ? { id: idFlag } : {});
  if (!outcome.ok) throw new CliError(`plan rejected:\n  - ${outcome.errors.join('\n  - ')}`, 1);

  const summary = {
    ok: true,
    created: outcome.created.map((c) => ({ id: c.id, title: c.title, risk: c.risk.level, depends_on: c.depends_on })),
    handback: outcome.handback,
    truncated: outcome.truncated,
  };
  const text = (): string => {
    const lines = outcome.created.map(
      (c) => `planned ${c.id} (DRAFT, risk ${c.risk.level}${c.depends_on.length > 0 ? `, after ${c.depends_on.join(',')}` : ''})`,
    );
    for (const h of outcome.handback) {
      lines.push(`handback ${h.id}: ${h.title}${h.reason !== undefined ? ` -- ${h.reason}` : ''} (needs the main session)`);
    }
    lines.push('review .router/tasks/<id>/, then `router run <id>` (or re-run plan with --execute)');
    return lines.join('\n');
  };

  if (!flagBool(ctx.args.flags, 'execute')) {
    emit(ctx.json, summary, text);
    return 0;
  }
  // --execute: freeze + queue everything, then start the first wave (no unmet deps).
  let rc = 0;
  for (const c of outcome.created) {
    const chainCtx: Ctx = { ...ctx, args: { ...ctx.args, flags: { ...ctx.args.flags, id: c.id } } };
    validate(chainCtx);
    queue(chainCtx);
  }
  for (const c of outcome.created.filter((c) => c.depends_on.length === 0)) {
    const chainCtx: Ctx = { ...ctx, args: { ...ctx.args, flags: { ...ctx.args.flags, id: c.id } } };
    rc = Math.max(rc, await run(chainCtx));
  }
  return rc;
};
```

- [ ] **Step 2: Add the `ready` handler** (before `selftestCmd`), register `ready,` in HANDLERS, and add `ready` to the help Ops line:

```ts
const ready: Handler = (ctx) => {
  const { paths } = depsFor(ctx);
  const queued = store.listTaskIds(paths).filter((t) => currentState(paths, t)?.state === 'QUEUED');
  const items = queued.map((t) => {
    let deps: string[] = [];
    try {
      deps = loadTask(paths, t).task.depends_on ?? [];
    } catch {
      // unreadable task.yaml -> treat as no deps; validate/run will surface the real error
    }
    const unmet = deps.filter((d) => currentState(paths, d)?.state !== 'MERGED');
    return { id: t, unmet };
  });
  const runnable = items.filter((i) => i.unmet.length === 0).map((i) => i.id);
  const blocked = items.filter((i) => i.unmet.length > 0);
  emit(ctx.json, { ok: true, ready: runnable, blocked }, () => {
    const lines = [runnable.length > 0 ? `ready: ${runnable.join(', ')}` : 'ready: (none)'];
    for (const b of blocked) lines.push(`  blocked ${b.id}: waiting on ${b.unmet.join(', ')}`);
    return lines.join('\n');
  });
  return 0;
};
```

- [ ] **Step 3: Wave e2e** (append to `test/cli-plan.test.ts`; reuses `repo()`/`router()`/fakes):

```ts
test('multi-task: plan --execute runs wave 1; dep gate + ready drive wave 2', async () => {
  chmodSync(FAKE_PLANNER, 0o755);
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nworker:\n  kind: codex\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CLAUDE_BIN: FAKE_PLANNER, ROUTER_FAKE_PLAN: 'multi', ROUTER_CODEX_BIN: FAKE_CODEX };
  try {
    const r = router(dir, ['plan', 'big goal', '--execute', '--json'], env);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.out.split('\n').filter(Boolean).pop()!);
    // task-b is dep-blocked while task-a is unmerged:
    const blocked = router(dir, ['run', 'task-b'], env);
    assert.equal(blocked.code, 1);
    assert.match(blocked.out, /task-a/);
    // wave 1 completes:
    let state = 'RUNNING';
    for (let i = 0; i < 60; i++) {
      state = JSON.parse(router(dir, ['status', 'task-a', '--json']).out).state;
      if (['PASSED', 'FAILED'].includes(state)) break;
      await sleep(200);
    }
    assert.equal(state, 'PASSED');
    assert.equal(router(dir, ['merge', 'task-a']).code, 0);
    // now ready exposes task-b:
    const ready = JSON.parse(router(dir, ['ready', '--json']).out);
    assert.deepEqual(ready.ready, ['task-b']);
    assert.equal(router(dir, ['run', 'task-b'], env).code, 0);
    for (let i = 0; i < 60; i++) {
      state = JSON.parse(router(dir, ['status', 'task-b', '--json']).out).state;
      if (['PASSED', 'FAILED'].includes(state)) break;
      await sleep(200);
    }
    assert.equal(state, 'PASSED');
    void out;
  } finally {
    fx.cleanup(dir);
  }
});
```

Also update the two existing cli-plan tests to the new output shape (`out.created[0].id === 'slugify'`; and the `--execute` single-task test polls `slugify` as before -- N=1 has no deps so wave 1 runs it).

- [ ] **Step 4: Run + commit**

Run: `npm run check`
Expected: `# fail 0`.

```bash
git add src/cli/commands.ts test/cli-plan.test.ts
git commit -m "feat(dispatch): plan batch output + ready verb + wave e2e"
```

---

### Task 7: Plugin guidance, docs, version 0.3.0, final gate

**Files:**
- Modify: `commands/plan.md`, `commands/init.md`; Create: `commands/ready.md`
- Modify: `README.md`, `docs/quickstart.md`
- Modify: `package.json`, `.claude-plugin/plugin.json` (0.3.0)
- Regenerate: `dist/router.js`

- [ ] **Step 1: `commands/ready.md`:**

```markdown
---
description: List router tasks whose dependencies are merged and can run now
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" ready --json`

Report which tasks are ready to run (`/router:run <id>`) and which are still blocked
on unmerged dependencies. Drive the batch wave by wave: run everything ready, review
and merge PASSED results, then check ready again until nothing is left.
```

- [ ] **Step 2: Update `commands/plan.md`** -- describe the batch outcome and the full loop:

```markdown
---
description: Decompose a goal into router tasks (claude proposes, router validates)
argument-hint: <goal>
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" plan "$ARGUMENTS" --json`

router validated claude's proposed task batch deterministically (or rejected it all).

If it succeeded:
- Summarize each created task (id, scope, risk, dependencies).
- HANDBACK tasks were NOT dispatched -- they need judgment. Handle them here in the
  main session: clarify with the user, split further, or do them directly.
- Drive the batch: `/router:run <id>` for every task `/router:ready` reports, review
  and merge PASSED results (`/router:result`, `/router:merge`), then check
  `/router:ready` again for the next wave, until the batch is done.
- When the whole batch is merged: ask the user how to build and test this project
  (do not assume), run those commands in the user's real checkout, and report the
  integration result. Offer to save the commands into `.router/policy.yaml`
  `verification` for future runs.

If it was rejected, show the reasons -- the proposal failed a deterministic check
(unknown build/test ref, too-broad scope, duplicate ids, a dependency cycle) and
nothing was created.
```

- [ ] **Step 3: `commands/init.md`** -- keep it strictly zero-config (drop the "replace verification now" ask; the build/test conversation happens at integration time, guided by plan.md):

```markdown
---
description: Initialize router in this repo -- scaffold .router/ (zero-config)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/router.js" init`

Confirm `.router/` was created, then commit it (router reads policy from the
committed base_sha, not the working tree). Nothing else is required: the default
policy works as-is. Do not ask the user to configure anything now -- the build/test
conversation happens later, at integration time, after a batch is merged.
```

- [ ] **Step 4: README + quickstart touch.** In README's Quickstart, after the `/router:plan` line, add:

```
/router:ready                        # which tasks can run now (deps merged)
```

and one sentence under the quickstart block: "A big goal may decompose into several
tasks: clear ones are dispatched (optionally to a cheaper model via `tiers`),
unclear ones come back for discussion, and dependent tasks unlock as their
prerequisites merge." In `docs/quickstart.md`, add a short "Multi-task dispatch"
subsection saying the same and showing the `tiers` policy snippet:

```yaml
tiers:
  clear: { kind: claude, model: sonnet }
```

- [ ] **Step 5: Version bump** `package.json` and `.claude-plugin/plugin.json` to `0.3.0`.

- [ ] **Step 6: Final gate + bundle**

Run: `npm run check && npm run build && node dist/router.js selftest`
Expected: `# fail 0`; `built dist/router.js (v0.3.0)`; `selftest PASSED`.
Also: `grep -rP "[^\x00-\x7F]" README.md docs/quickstart.md commands/ | wc -l` -> 0.

- [ ] **Step 7: Commit + PR**

```bash
git add commands/ README.md docs/quickstart.md package.json .claude-plugin/plugin.json dist/router.js
git commit -m "feat(dispatch): plugin wave-driving guidance, docs, v0.3.0"
git push -u origin feat-multi-task-dispatch
gh pr create --base main --title "feat: multi-task dispatch (decompose, tier, dependency gate)" ...
```

---

## Self-Review

**Spec coverage:** multi-task planning (T2), batch+DAG validation (T3), tier mapping + handback (T4), dependency gate + ready + waves (T5/T6), zero-config init + integration-time build/test conversation (T7 guidance), version bump (T7). Out-of-scope items untouched. Covered.

**Placeholder scan:** all steps carry full code; the two "adjust existing tests" steps name the exact assertions to change.

**Type consistency:** `ProposedTask`/`HandbackItem`/`PlanBatchResult` (T1) match usage in T3/T4; `PlanOutcome.created: PlannedTaskInfo[]` (T4) matches the CLI handler (T6); `DependencyError` name checked in T5 test and caught in T6's run handler; `parseAndCheckBatch(rawText, ctx)` signature consistent across T3/T4.

**Deviations:** none from the spec; `--id` restricted to single-task plans (deterministic, documented in T4).
