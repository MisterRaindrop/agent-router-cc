// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import { ROUTER_DIR, VERSION } from '../domain/constants.ts';
import type { ModelSpec, WriteRecord } from '../domain/types.ts';
import { EXECUTOR_SANDBOX_ENV } from '../io/env.ts';
import { findRouterDir, routerPaths, type RouterPaths } from '../io/paths.ts';
import { loadModelConfig, modelsYamlPath } from '../app/modelConfig.ts';
import { readWriteRecord, resumeWrite, WriteRefusal, writeWithCodex } from '../app/write.ts';
import { isDegraded, loadCodeIntelConfig, runIndex, runQuery } from '../app/symbolIndex.ts';
import { parseSymbols } from '../io/treeSitter.ts';
import { superviseCommand } from '../app/supervise.ts';
import { CliError, emit, err } from './output.ts';
import { flagStr, type ParsedArgs } from './args.ts';

// The CLI behind the slash commands. Since 0.15.0 the main session writes the code itself, so
// what is left here is what a session cannot do from a prompt alone: launch codex as an external
// writer and resume it (write, resume), run a long command under the watchdog (supervise),
// list plan documents (plans), show the models it launches (models), and the symbol index.

export interface Ctx {
  args: ParsedArgs;
  cwd: string;
  json: boolean;
}
type Handler = (ctx: Ctx) => number | Promise<number>;

// Auto-scaffold: no `init` needed. If no .router is found up-tree, create one at the cwd;
// `.router/` is fully gitignored so router state never pollutes the repo.
//
// Except from inside a codex writer, where every WRITING verb is refused: a writer that runs
// `router write` from inside its own run would launch a second writer into the same checkout.
// Read-only verbs stay available -- a writer may look at the plan it is part of.
function depsFor(ctx: Ctx, readOnly = false): { paths: RouterPaths } {
  if (!readOnly && (process.env[EXECUTOR_SANDBOX_ENV] ?? '') !== '') {
    throw new CliError(
      `refusing to WRITE router state from inside a writer (${EXECUTOR_SANDBOX_ENV} is set). ` +
        `Work through files, git and the project's own tests. Read-only verbs (plans, models, symbol) are available.`,
      2,
    );
  }
  const explicit = flagStr(ctx.args.flags, 'router-dir');
  const found = explicit ?? findRouterDir(ctx.cwd);
  const paths = routerPaths(found ?? join(ctx.cwd, ROUTER_DIR));
  if (!readOnly) {
    if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true });
    const gi = join(paths.root, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '*\n');
  }
  return { paths };
}

// `spec.lock` is the per-plan lock a design session writes (historical name). The listing only
// says whether one is held: a JSON object with a positive integer pid. Liveness is not checked --
// the column reports what is on disk, as it always has.
function planLocked(path: string): boolean {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return Number.isInteger(v.pid) && (v.pid as number) > 0;
  } catch {
    return false;
  }
}

// -- external writer ----------------------------------------------------------

function writerPin(ctx: Ctx, fallback: ModelSpec): ModelSpec {
  const model = flagStr(ctx.args.flags, 'model');
  const effort = flagStr(ctx.args.flags, 'effort');
  if (model === undefined && effort === undefined) return fallback;
  const m = model ?? fallback.model;
  // An explicit model without an effort keeps the default effort only when it is the same model;
  // otherwise the effort is omitted rather than borrowed from a different model's default.
  const e = effort ?? (m === fallback.model ? fallback.effort : undefined);
  return { model: m, ...(e !== undefined ? { effort: e } : {}) };
}

function minutes(ctx: Ctx, name: string): number | undefined {
  const raw = flagStr(ctx.args.flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--${name} must be a positive number of minutes`, 2);
  return n;
}

function writeSummary(r: WriteRecord): string {
  const lines = [
    `write ${r.id}: ${r.exit_class} (model ${r.model}${r.effort ? `/${r.effort}` : ''}, on ${r.branch})`,
    `  session:   ${r.session_id ?? 'none reported'}${r.resumes > 0 ? `  (resumed ${r.resumes}x)` : ''}`,
    `  base:      ${r.base_sha.slice(0, 12)}  -- review with: git diff ${r.base_sha.slice(0, 12)}..HEAD`,
    `  commits:   ${r.commits.length === 0 ? 'none' : ''}`,
    ...r.commits.map((c) => `    ${c}`),
  ];
  if (r.uncommitted.length > 0) lines.push(`  UNCOMMITTED (${r.uncommitted.length}):`, ...r.uncommitted.map((u) => `    ${u}`));
  if (r.resume_session_mismatch) {
    lines.push('  RESUME DID NOT RE-ATTACH: codex reported a different session (or none). Treat this as a fresh run.');
  }
  if (r.model_mismatch) lines.push('  the CLI rejected the model slug -- set `writer:` in .router/models.yaml');
  if (r.final_message) lines.push('  final message:', ...r.final_message.trimEnd().split('\n').map((l) => `    ${l}`));
  return lines.join('\n');
}

function writeExit(r: WriteRecord): number {
  return r.exit_class === 'ok' && !r.resume_session_mismatch ? 0 : 1;
}

const write: Handler = async (ctx) => {
  const { paths } = depsFor(ctx);
  const id = flagStr(ctx.args.flags, 'id') ?? ctx.args.positionals[0];
  if (id === undefined || id === '') throw new CliError('write requires an id: router write <id> --brief <file>', 2);
  const briefPath = flagStr(ctx.args.flags, 'brief');
  if (briefPath === undefined || briefPath === '') throw new CliError('write requires --brief <file>', 2);
  let brief: string;
  try {
    brief = readFileSync(resolve(ctx.cwd, briefPath), 'utf8');
  } catch (e) {
    throw new CliError(`cannot read brief ${briefPath}: ${(e as Error).message}`, 2);
  }
  if (brief.trim() === '') throw new CliError(`brief ${briefPath} is empty`, 2);
  const maxWall = minutes(ctx, 'max-wall-minutes');
  const stall = minutes(ctx, 'stall-minutes');
  try {
    const r = await writeWithCodex(paths, {
      id,
      brief,
      model: writerPin(ctx, loadModelConfig(paths).writer),
      ...(maxWall !== undefined ? { maxWallMinutes: maxWall } : {}),
      ...(stall !== undefined ? { stallMinutes: stall } : {}),
    });
    emit(ctx.json, { ok: writeExit(r) === 0, ...r }, () => writeSummary(r));
    return writeExit(r);
  } catch (e) {
    if (e instanceof WriteRefusal) throw new CliError(e.message, 2);
    throw e;
  }
};

const resume: Handler = async (ctx) => {
  const { paths } = depsFor(ctx);
  const id = flagStr(ctx.args.flags, 'id') ?? ctx.args.positionals[0];
  if (id === undefined || id === '') throw new CliError('resume requires an id: router resume <id> --feedback "..."', 2);
  const feedback = flagStr(ctx.args.flags, 'feedback');
  if (feedback === undefined || feedback.trim() === '') throw new CliError('resume requires --feedback "<what to fix>"', 2);
  const prev = readWriteRecord(paths, id);
  const fallback: ModelSpec | undefined =
    prev === null ? undefined : { model: prev.model, ...(prev.effort !== undefined ? { effort: prev.effort } : {}) };
  try {
    const r = await resumeWrite(paths, id, feedback, fallback === undefined ? undefined : writerPin(ctx, fallback));
    emit(ctx.json, { ok: writeExit(r) === 0, ...r }, () => writeSummary(r));
    return writeExit(r);
  } catch (e) {
    if (e instanceof WriteRefusal) throw new CliError(e.message, 2);
    throw e;
  }
};

// -- plans --------------------------------------------------------------------

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

const DOCUMENT_FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BRAINSTORM_STATUSES = new Set(['brainstorming', 'converged', 'rejected']);
// `design_abandoned` is terminal, and it exists because there was no terminal state to reach. A
// design flow the user stops part-way -- "just do the whole thing, skip the design" -- left its
// document on `design_draft` forever, so `router plans` listed finished work as the only unfinished
// plan and every review of what was outstanding had to explain it again. Brainstorm has `rejected`
// for the same situation; design had nothing.
// `design_implemented` is the other terminal state, and it replaced the work plan's `done` when
// the work-plan stage was removed in 0.14.0. The design is now the only document a plan has, so
// without a terminal status of its own an approved design stayed `design_approved` forever and
// this listing could not tell "approved, not started" from "built and accepted". `/router:review`
// is the only stage that writes it.
const DESIGN_STATUSES = new Set([
  'design_draft',
  'design_approved',
  'design_implemented',
  'design_abandoned',
]);
// LEGACY. Nothing writes a work plan any more (removed in 0.14.0), but plan directories written
// before that still declare these statuses, and they are the only record that the work finished.
// Dropping this vocabulary would make every historical plan fall through to its `design_approved`
// DESIGN.md and report finished work as not started -- the exact regression `design_implemented`
// exists to prevent.
const LEGACY_PLAN_STATUSES = new Set(['plan_draft', 'plan_approved', 'executing', 'done']);

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

// Legacy work plans declare `revision`; `plan_revision` remains readable for artifacts frozen by
// the flow before that. Malformed or missing frontmatter degrades only this row. Current plans
// have no work plan at all, so this reads null for them and the column renders `-`; their revision
// is the design's, in its own column.
//
// KNOWN LIMIT, reported 2026-09-01 and deliberately not fixed: this conflates "absent" with
// "invalid", which is the same blind spot the stage column was just fixed for. `scalarText` returns
// null for a boolean, an array or a mapping, so `revision: []` beside a legacy `plan_revision: old`
// silently reports `old` and hides that the authoritative field is corrupt; an invalid revision and
// no revision at all both render `-`; and `revision: ""` renders a visually empty column. Closing it
// means a present-valid / present-invalid / absent tri-state through both callers and both columns,
// which is a wider change than the one it was found in.
function planRevision(frontmatter: Record<string, unknown> | null): string | null {
  return scalarText(frontmatter?.revision) ?? scalarText(frontmatter?.plan_revision);
}

/** Frontmatter of one document in a plan directory, or null when absent or unreadable. */
/**
 * One document of a plan, with existence kept separate from readability.
 *
 * A single `null` used to answer both "there is no such file" and "the file is there and says
 * nothing I can use", and the plans listing then reported them identically. Those are different
 * facts about a plan: one is a stage not started, the other is damage.
 */
interface PlanDocument {
  exists: boolean;
  frontmatter: Record<string, unknown> | null;
}

function planDocument(paths: RouterPaths, planId: string, name: string): PlanDocument {
  try {
    const text = readFileSync(join(paths.planDir(planId), name), 'utf8');
    return { exists: true, frontmatter: documentFrontmatter(text) };
  } catch (error) {
    // Present but unreadable -- a permission error, a directory in its place -- is damage, not
    // absence, and only ENOENT means the stage was never started.
    return { exists: (error as NodeJS.ErrnoException).code !== 'ENOENT', frontmatter: null };
  }
}

function documentStage(frontmatter: Record<string, unknown> | null, allowed: Set<string>): string | null {
  const status = frontmatter?.status;
  return typeof status === 'string' && allowed.has(status) ? status : null;
}

// Anything read out of a file and written to a terminal goes through here first: an escape sequence
// in that text would move the cursor or set a colour instead of being read. Everything outside
// printable ASCII becomes `.`, which covers ESC, the C0 and C1 ranges, DEL, CR, LF and TAB, and
// keeps the value measurable -- a double-width glyph counts as one unit to width() but takes two
// cells on the terminal, so leaving it in rags the table.
function printable(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, '.');
}

/**
 * One cell whose value came out of frontmatter: sanitized, and bounded.
 *
 * The bound is not tidiness. A YAML scalar has no size limit, so a multi-megabyte value used to be
 * copied whole into the row, into the width calculation, and onto stdout -- one plan could make the
 * listing unreadable. The full value stays in `--json`, which is where a caller that actually wants
 * it should look.
 *
 * It applies to frontmatter ONLY, and not to a plan id: an id is a directory name, bounded by the
 * filesystem and chosen by the person running router, and this table's own test pins that a long one
 * widens the table rather than being cut -- it is the row's key, and half a key is worse than a wide
 * column. Measured: a 32-char cap truncated `2026-08-12-a-design-plan-id-that-is-longer-...` and
 * that test went red, which is exactly what it is for.
 */
const CELL_MAX = 32;

function frontmatterCell(raw: string): string {
  const clean = printable(raw);
  return clean.length <= CELL_MAX ? clean : `${clean.slice(0, CELL_MAX - 3)}...`;
}

/**
 * What the stage column reports for a document that is on disk and unusable.
 *
 * `-` cannot say this: it means "no document, or no status declared", and a plan whose DESIGN.md
 * has broken frontmatter is neither.
 *
 * Three causes reach it, and they are one fact from the listing's side -- the document exists and
 * cannot be read as a stage record: the file could not be opened at all, it has no frontmatter
 * block, or the block is not valid YAML.
 *
 * `!` rather than the `?` an unrecognized status carries, because those are different facts: `?`
 * reports what the field says, `!` reports that there was nothing to read. No status vocabulary
 * contains either character, and a status literally spelled `unreadable` renders `?unreadable`, so
 * the two never collide.
 */
const UNREADABLE_DOCUMENT = '!unreadable';

/**
 * The stage to report when `documentStage` recognized nothing, or null when the document declared
 * nothing at all.
 *
 * Two jobs, and the caller depends on both: the string is what the row shows, and the null is what
 * lets the search fall through to the next document. Recognition itself stays in `documentStage`;
 * this only names what that rejected, marked with `?` so the value cannot be misread as a stage
 * name -- no vocabulary contains a `?`.
 *
 * `-` keeps meaning "nothing declared", so this returns null for four different ways of writing
 * nothing: no `status` key, a YAML null, an empty string, and a run of plain spaces. A mapping or a
 * sequence is not a status either.
 */
function unrecognizedStage(frontmatter: Record<string, unknown> | null, allowed: Set<string>): string | null {
  const status = frontmatter?.status;
  if (status === undefined || status === null || typeof status === 'object') return null;
  if (documentStage(frontmatter, allowed) !== null) return null;
  // Only PLAIN SPACES are stripped, not `String.trim()`'s idea of whitespace, and the difference is
  // the whole point: trim() also removes TAB, CR, LF, VT, FF, NBSP, FEFF and U+2028, so
  // `status: "\t\r"` became `-` while `status: "\e\a"` became `?..` -- the same rule answering two
  // ways for no reason the reader could see. A control character is not the author writing nothing;
  // it is a corrupted field, and `-` there hides exactly the damage this column exists to show.
  // Padding is still stripped so the file's own spaces cannot rag the column, and recognition stays
  // exact, so a padded copy of a recognized word is marked rather than quietly accepted as it.
  const shown = String(status).replace(/^ +| +$/g, '');
  return shown === '' ? null : `?${printable(shown)}`;
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

// List plan artifacts under .router/plans -- document stage, a legacy work plan's declared
// revision where one exists, the design's revision, the highest critique round, decisions, and
// lock state. This handler deliberately avoids
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
    let stage = hasPlan ? documentStage(planFrontmatter, LEGACY_PLAN_STATUSES) : null;
    // The design's own revision. For every plan written since 0.14.0 this is THE revision: there
    // is no work plan, so the other column is `-`. The two columns stay separate because the
    // historical plans on disk have both, and conflating them would reattribute one document's
    // revision to the other.
    let designRevision: string | null = null;
    let designFrontmatter: Record<string, unknown> | null = null;
    // Existence is tracked separately from readability, exactly as `hasPlan` is: a DESIGN.md that
    // is present but unparseable is damage, and a DESIGN.md that is absent is a stage not started.
    // Both used to arrive here as `null` and were therefore indistinguishable.
    let hasDesign = true;
    try {
      designFrontmatter = documentFrontmatter(readFileSync(join(paths.planDir(id), 'DESIGN.md'), 'utf8'));
      designRevision = scalarText(designFrontmatter?.revision);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hasDesign = false;
      /* present but unreadable: it still owns the stage, which therefore stays unknown */
    }
    // The document that EXISTS owns the stage -- work plan, else design, else brainstorm -- and the
    // search stops there. It is not "the furthest document whose status this build recognizes",
    // which is what it used to be, and the difference is the whole point of this column: a DESIGN.md
    // declaring `desgin_draft` fell through to a `converged` BRAINSTORM below it, so the listing
    // reported a finished earlier stage and the typo in the design stayed completely invisible --
    // the exact blind spot the mark was added to remove, reproduced one level up.
    //
    // `hasPlan` already worked this way, and its comment already said why: a plan on disk means the
    // earlier stages are done, so reporting "brainstorming" over a broken plan reads as regress
    // rather than as damage. The design level simply never got the same treatment.
    //
    // The limit recorded here in 0.12.6 -- "present but unparseable reports `-`, the same as no
    // document" -- is closed: that case reports `!unreadable`, see UNREADABLE_DOCUMENT.
    //
    // Within the owning document there are three answers, not two: a status it declares, `-` when it
    // declares none, and `!unreadable` when the document is there and its frontmatter is not. That
    // last one used to collapse into `-`, so "the design is damaged" and "there is no design" read
    // the same -- the same conflation as the stage column itself, one level down.
    const declared = (
      frontmatter: Record<string, unknown> | null,
      allowed: Set<string>,
    ): string | null =>
      frontmatter === null
        ? UNREADABLE_DOCUMENT
        : documentStage(frontmatter, allowed) ?? unrecognizedStage(frontmatter, allowed);

    if (hasPlan) {
      stage ??= declared(planFrontmatter, LEGACY_PLAN_STATUSES);
    } else if (hasDesign) {
      stage = declared(designFrontmatter, DESIGN_STATUSES);
    } else {
      const brainstorm = planDocument(paths, id, 'BRAINSTORM.md');
      stage = brainstorm.exists ? declared(brainstorm.frontmatter, BRAINSTORM_STATUSES) : null;
    }
    let critiqueRound: number | null = null;
    try {
      critiqueRound = highestCritiqueRound(readdirSync(paths.planDir(id)));
    } catch {
      /* plan dir unreadable -- treat as no critiques rather than failing the row */
    }
    // KNOWN LIMIT, reported 2026-09-01 and deliberately not fixed: `stage` carries a presentation
    // decision into `--json`, which `src/cli/output.ts` calls stable machine output. A consumer that
    // accepted one of the three vocabularies or null may now see `?unexpected`, and the sanitized
    // form is lossy -- a non-ASCII status survives only as dots. The clean shape is a structured
    // {kind, raw, recognized} with `stage` kept to its enum, but that changes the JSON contract; the
    // repository has no producer-side consumer (four test call sites, no other reader), so the cost
    // was judged higher than the exposure. Revisit if anything starts parsing this field.
    return {
      id,
      plan_revision: planRevision(planFrontmatter),
      design_revision: designRevision,
      stage,
      critique_round: critiqueRound,
      decisions: existsSync(paths.specDecisions(id)),
      locked: planLocked(paths.specLock(id)),
    };
  });
  emit(ctx.json, { ok: true, plans: rows }, () => {
    if (rows.length === 0) return 'No plans in .router/plans.';
    // EVERY text cell is sanitized here, at the boundary, not at the one place a defect was found.
    // `stage` was hardened on its own first and the other three columns stayed raw: a directory name
    // and both revisions are arbitrary text out of the same files, and `revision: "r<ESC>[31mRED"`
    // put two escape bytes on the terminal -- measured. The bound is applied to the same value the
    // width is computed from, so a capped cell and its column always agree.
    const cell = frontmatterCell;
    const width = (header: string, floor: number, values: string[]): number =>
      Math.max(floor, header.length + 1, ...values.map((value) => value.length + 1));
    const idWidth = width('id', 24, rows.map((r) => printable(r.id)));
    // `-`, not `unknown`: since 0.14.0 the absence of a work plan is the normal state, and
    // `unknown` in every row of a column reads as damage rather than as "that stage is gone".
    const revisionWidth = width('workplan', 12, rows.map((r) => cell(r.plan_revision ?? '-')));
    const designWidth = width('design', 8, rows.map((r) => cell(r.design_revision ?? '-')));
    const stageWidth = width('stage', 8, rows.map((r) => cell(r.stage ?? '-')));
    const critiqueWidth = width('critique', 10, rows.map((r) => r.critique_round === null ? '-' : String(r.critique_round)));
    const decisionsWidth = width('decisions', 12, rows.map((r) => r.decisions ? 'yes' : '-'));
    const lines = [
      `Plans (${rows.length}):`,
      pad('id', idWidth) + pad('design', designWidth) + pad('workplan', revisionWidth) + pad('stage', stageWidth) + pad('critique', critiqueWidth) + pad('decisions', decisionsWidth) + 'locked',
    ];
    for (const r of rows)
      lines.push(
        pad(printable(r.id), idWidth) +
          pad(cell(r.design_revision ?? '-'), designWidth) +
          pad(cell(r.plan_revision ?? '-'), revisionWidth) +
          pad(cell(r.stage ?? '-'), stageWidth) +
          pad(r.critique_round === null ? '-' : String(r.critique_round), critiqueWidth) +
          pad(r.decisions ? 'yes' : '-', decisionsWidth) +
          (r.locked ? 'yes' : '-'),
      );
    return lines.join('\n');
  });
  return 0;
};

const models: Handler = (ctx) => {
  const { paths } = depsFor(ctx, true /* read-only */);
  const cfg = loadModelConfig(paths);
  emit(ctx.json, { ok: true, models: cfg }, () => {
    const writer = `${cfg.writer.model}${cfg.writer.effort ? `/${cfg.writer.effort}` : ''}`;
    const review = cfg.review.map((r) => `${r.kind}:${r.model ?? '?'}${r.effort ? `/${r.effort}` : ''}`).join(' -> ');
    const src = existsSync(modelsYamlPath(paths)) ? 'default + .router/models.yaml' : 'default';
    return `models (${src}):\n  writer: codex:${writer}\n  review: ${review}`;
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

/**
 * What to print when the tree-sitter probe throws.
 *
 * `(e as Error).message` alone is not enough, and the gap cost real time: a grammar whose ABI the
 * runtime refuses throws an Error with an EMPTY message, so `doctor` reported
 * `tree-sitter: UNAVAILABLE ()` -- the one line whose job is to say why, saying nothing. Diagnosing
 * it needed a hand-written probe script. Measured on `web-tree-sitter` 0.26.13 against
 * `tree-sitter-wasms` ^0.1.13, where `Parser.init` succeeds and `Language.load` is what fails.
 */
export function describeLoadFailure(e: unknown): string {
  const err = e as Partial<Error> & { code?: string };
  const parts = [
    err?.name ?? typeof e,
    ...(typeof err?.code === 'string' ? [err.code] : []),
    ...(typeof err?.message === 'string' && err.message.trim() !== '' ? [err.message] : []),
  ];
  const detail = parts.join(': ');
  // An empty message almost always means the runtime rejected the grammar, and the two versions
  // move independently -- so name both, rather than leave the reader with a bare `Error`.
  return typeof err?.message === 'string' && err.message.trim() === ''
    ? `${detail} -- no message; usually a grammar the runtime will not accept, ` +
        `so check web-tree-sitter and tree-sitter-wasms against each other`
    : detail;
}

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
    wasmDetail = describeLoadFailure(e);
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
  const log = flagStr(ctx.args.flags, 'log');
  if (log === undefined || log === '') throw new CliError('supervise requires --log <file>', 2);
  const argv = ctx.args.passthrough;
  if (argv === undefined) throw new CliError("supervise requires '--' before the command", 2);
  if (argv.length === 0 || argv[0] === '') throw new CliError('supervise requires a command after --', 2);
  // `--label` is still accepted, so a review brief written for an older build keeps working; it
  // named the statusline entry, which was removed in 0.15.0.
  void flagStr(ctx.args.flags, 'label');

  const result = await superviseCommand({
    logPath: resolve(ctx.cwd, log),
    argv,
    cwd: ctx.cwd,
    // Match direct foreground execution: the caller chooses the command and its environment.
    env: process.env,
  });
  for (const diagnostic of result.diagnostics) err(`router: supervise cleanup: ${diagnostic}`);
  return result.exitCode;
};

export const HANDLERS: Record<string, Handler> = {
  write,
  resume,
  plans,
  models,
  symbol,
  doctor,
  supervise: superviseHandler,
};

export function versionText(): string {
  return VERSION;
}

export function helpText(): string {
  return (
    `router ${VERSION}\n\n` +
    `Usage: router <command> [options]\n\n` +
    `  write <id> --brief <file> [--model M] [--effort E]  have codex write on the current branch (clean tree required)\n` +
    `  resume <id> --feedback "..."  send feedback to that write's same codex session\n` +
    `  plans                  list .router/plans/<id> artifacts: revision, stage, critique round, decisions, lock\n` +
    `  models                 print the writer and reviewer models (default + .router/models.yaml)\n` +
    `  symbol <sub> [args]    out-of-context symbol index: index [dirs] | find <name> | enclosing <file> <line> | methods <Class> | callers <name> | callees <fn>\n` +
    `  doctor                 self-check the code-intelligence layer (config, wasm, cache)\n` +
    `  supervise --log F -- <argv...>  run a long command under the watchdog, output to F\n\n` +
    `Flags: --json, --limit, --id, --brief, --model, --effort, --feedback, --max-wall-minutes, --stall-minutes, --log, --router-dir\n`
  );
}
