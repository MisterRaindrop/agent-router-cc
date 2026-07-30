// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Central domain types. Leaf module: imports nothing, imported by every ring.

// -- Worker exit taxonomy ----------------------------------------------------
// env_error is special: it does NOT count as a real attempt.
export type ExitClass =
  | 'ok'
  | 'task_failed'
  | 'timeout'
  | 'stalled'
  | 'killed'
  | 'worker_crash'
  | 'env_error'
  | 'quota_exhausted'; // provider rate-limit/quota hit; does NOT count as an attempt

export type WorkerKind = 'codex' | 'claude'; // both are plan-auth CLIs; more can be added

/** An executor pin: which CLI runs the task, and (optionally) which model slug. */
export interface WorkerPolicy {
  kind: WorkerKind;
  api_key_env?: string; // env var to whitelist into the worker (plan-auth CLIs need none)
  model?: string; // pinned model slug passed to the worker (-m / --model); recorded in runs
  effort?: string; // reasoning-effort level (codex -c model_reasoning_effort= ; claude --effort)
  max_wall_minutes_default?: number;
  stall_minutes?: number;
}

// -- Tiered model routing (config-driven; see app/modelConfig.ts) ---------------
// Opus judges each dispatch task's difficulty and tags a tier; the config maps
// tier -> {model, effort} per executor, and router still picks the executor by
// quota. spec/review always use the strongest, independent reviewer (config.review).
export type ModelTier = 'weak' | 'strong';

/** One model choice: a slug plus an optional reasoning-effort level. */
export interface ModelSpec {
  model: string;
  effort?: string;
}

/** The model menu: per-executor weak/strong slugs + the ordered reviewer chain. */
export interface ModelTierConfig {
  codex: { weak: ModelSpec; strong: ModelSpec };
  claude: { weak: ModelSpec; strong: ModelSpec };
  /** spec/review reviewer candidates, strongest first (kind + model + effort). */
  review: WorkerPolicy[];
}

// -- task.yaml (machine contract; schema-validated) ----------------------------
export interface TaskYaml {
  schema_version: 1;
  id: string;
  /** Dispatch-plan identifier; absent for tasks created before plan grouping. */
  plan_id?: string;
  title: string;
  base_sha: string | null; // null until a diff is produced against a base commit (40-hex)
  max_wall_minutes: number;
  allowed_globs: string[];
  forbidden_globs?: string[];
  max_changed_lines?: number;
  /** The mechanical verify command(s) run on the diff (argv arrays; [] = none). */
  verify?: string[][];
  /** Difficulty tier Opus assigns; resolves to per-executor model+effort via config. */
  tier?: ModelTier;
  /** Explicit executor pin (kind + optional model); overrides `tier` when set. */
  worker?: WorkerPolicy;
}

// -- Effective scope (task-derived, precomputed by the app layer) --------------
// core/scope.ts consumes this so it stays pure and free of merge policy.
export interface EffectiveScope {
  allowed_globs: string[];
  forbidden_globs: string[];
  test_globs: string[];
  max_changed_lines: number;
}

// -- Parsed git diff entry (produced by io/git, consumed by core/scope) --------
export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface DiffEntry {
  status: DiffStatus;
  path: string; // new path (or the path for A/M/D)
  oldPath?: string; // set for renames/copies
  added: number;
  deleted: number;
  binary: boolean;
  newMode?: string; // git file mode of the new blob, e.g. '100644' / '100755'
}

export type ScopeViolationKind =
  | 'not_allowed'
  | 'forbidden'
  | 'test_deletion'
  | 'max_lines'
  | 'empty_diff';

export interface ScopeViolation {
  kind: ScopeViolationKind;
  path?: string;
  detail: string;
}

export interface ScopeVerdict {
  ok: boolean;
  changedLines: number;
  violations: ScopeViolation[];
}

// -- Verifier report -----------------------------------------------------------
export interface VerifierCheck {
  id: string;
  ok: boolean;
  detail?: string;
  rc?: number;
}

export interface VerifierReport {
  result: 'PASSED' | 'FAILED';
  checks: VerifierCheck[];
  changed_lines?: number;
}

// -- Run result + metrics ------------------------------------------------------
export interface RunResult {
  run_id: string;
  task_id: string;
  attempt_number: number;
  exit_class: ExitClass;
  rc: number | null;
  timed_out: boolean;
  stalled: boolean;
  env_error: boolean;
  started_at: string;
  ended_at: string;
  wall_seconds: number;
  worker: { kind: WorkerKind; model?: string; effort?: string };
  executor_switches?: number; // times we fell back to the next executor (quota/env)
  model_mismatch?: boolean; // executor rejected the configured slug -> config likely stale
  tokens?: { input: number; output: number };
  cost_usd?: number;
  verifier?: VerifierReport;
  diff_sha?: string;
  session_id?: string | null; // executor session/thread id, for a later `router resume`
  resumed?: boolean; // this run continued a prior executor session
  resume_session_mismatch?: boolean; // resume did NOT re-attach to the prior session (fail-loud)
  base_sha?: string; // commit the worktree branch was created from (diff base; used by resume)
  // `land` merges the run branch with --no-ff and then deletes it, so this merge
  // commit is the only durable handle on what the task changed:
  // `git show <merge_commit>` / `git diff <merge_commit>^1 <merge_commit>`.
  merge_commit?: string;
}

export interface MetricRecord {
  ts: string;
  task_id: string;
  /** Dispatch-plan identifier; absent on metrics recorded before plan grouping. */
  plan_id?: string;
  /** Whether this metric is for the main model or an executor. */
  role?: 'executor' | 'orchestrator';
  run_id: string;
  attempt_number: number;
  model: string | null;
  executor?: WorkerKind | null; // which executor produced this run
  exit_class: ExitClass;
  verifier_result: 'PASSED' | 'FAILED' | null;
  first_pass: boolean;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_usd: number | null;
  wall_seconds: number;
  escalated: boolean;
  env_error: boolean;
}

/** Real remaining-quota snapshot for one executor, read from its local usage source. */
export interface ExecutorQuota {
  kind: WorkerKind;
  used_percent: number; // 0..100 of the most-binding window (higher = less headroom)
  resets_at: number | null; // unix seconds when the binding window resets, if known
  available: boolean; // false when a hard limit was hit (reactive 429 / reached_type)
}

// -- code intelligence: symbol index (P1) --
// The persisted, out-of-context symbol map. io/ builds it (tree-sitter), core/
// queries it (pure), app/ serializes it. Kept out of the model's context on
// purpose: only per-query results (a few lines) are ever surfaced. See
// docs/design/code-intelligence-design.md.

export type SymbolKind = 'class' | 'struct' | 'fn' | 'decl';

/** One extracted symbol. Lines are 1-based; endLine is the node's last line. */
export interface Sym {
  kind: SymbolKind;
  name: string; // may be qualified, e.g. "IcebergMetadata::getColumnMapperForObject"
  line: number;
  endLine: number;
}

/** One syntactic call edge: `caller` (enclosing function) calls something named `callee`.
 *  Name-based and APPROXIMATE -- reference only, never authoritative (see core/symbols). */
export interface CallEdge {
  caller: string; // enclosing function's (qualified) name, or "<global>"
  callee: string; // simple name of the called symbol (trailing identifier)
  line: number;
}

/** Symbols of one file, plus the mtime used for query-time incremental refresh. */
export interface FileSymbols {
  file: string; // repo-relative path
  mtimeMs: number; // source mtime at index time; a change triggers re-parse
  symbols: Sym[];
  calls?: CallEdge[]; // syntactic call edges (optional; absent in older caches)
}

/** The whole index. `grammar` stamps the parser/grammar version for cache busting. */
export interface SymbolIndex {
  grammar: string;
  files: FileSymbols[];
}

/** Code-intelligence config (bundled default + optional .router/models.yaml override).
 *  Three switches, all default ON. `enabled` is the master; index/lsp are per-layer. */
export interface CodeIntelConfig {
  enabled: boolean; // master switch: false => whole layer off, spec/review/go use rg
  index: {
    enabled: boolean; // tree-sitter symbol index (P1)
    scope: string[]; // default roots to index when none given (repo-relative)
    maxFiles: number; // hard cap: over it => loud degrade, never silently index the world
    maxBytes: number;
    refresh: 'query' | 'manual'; // query = re-stat + reparse dirty before each query
  };
  lsp: {
    enabled: boolean; // precise-semantics LSP layer (P2); can be off while index stays on
  };
}
