// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Central domain types. Leaf module: imports nothing, imported by every ring.

// -- Worker exit taxonomy ----------------------------------------------------
// env_error is special: the environment was wrong (codex missing, not logged in), so the run
// says nothing about the work.
export type ExitClass =
  | 'ok'
  | 'contract_conflict'
  | 'task_failed'
  | 'timeout'
  | 'stalled'
  | 'killed'
  | 'worker_crash'
  | 'env_error';

/** `codex` writes code when the user names a model; `claude` remains a reviewer kind. */
export type WorkerKind = 'codex' | 'claude';

/** A model pin: which CLI, which slug, which reasoning effort. */
export interface WorkerPolicy {
  kind: WorkerKind;
  model?: string; // pinned model slug passed to the CLI (-m / --model)
  effort?: string; // reasoning-effort level (codex -c model_reasoning_effort=)
}

// -- Model choices (config-driven; see app/modelConfig.ts) ----------------------

/** One model choice: a slug plus an optional reasoning-effort level. */
export interface ModelSpec {
  model: string;
  effort?: string;
}

/** The models router launches: the external codex writer, and the ordered reviewer chain. */
export interface ModelConfig {
  /** `router write` default when no model is named. Always a codex slug. */
  writer: ModelSpec;
  /** design-review / review candidates, strongest first (kind + model + effort). */
  review: WorkerPolicy[];
}

// -- External writer runs (see app/write.ts) -----------------------------------

/** What one `router write` / `router resume` did, recorded at `.router/writes/<id>/record.json`. */
export interface WriteRecord {
  id: string;
  model: string;
  effort?: string;
  /** The branch the writer worked on. A resume refuses to run anywhere else. */
  branch: string;
  /** HEAD when the first write started: every commit the writer made is `base_sha..HEAD`. */
  base_sha: string;
  /** codex's own session id; what `router resume` re-attaches to. */
  session_id: string | null;
  exit_class: ExitClass;
  rc: number | null;
  started_at: string;
  ended_at: string;
  /** How many times this session has been resumed. */
  resumes: number;
  /** `git log --oneline base_sha..HEAD` after the run. */
  commits: string[];
  /** Files the writer left modified or untracked -- work it did not commit. */
  uncommitted: string[];
  /** The writer's last message, verbatim. */
  final_message?: string;
  /** Set when a resume reported a different session (or none): the run is not a continuation. */
  resume_session_mismatch?: boolean;
  /** Set when the CLI rejected the configured model slug. */
  model_mismatch?: boolean;
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
