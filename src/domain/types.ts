// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Central domain types. Leaf module: imports nothing, imported by every ring.

// -- Task state machine ------------------------------------------------------
// The full graph (incl. M2 states) lives here so transitions "exist" from day 1;
// M1 only drives a subset (see core/stateMachine.ts).
export type TaskState =
  | 'DRAFT'
  | 'VALIDATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'VERIFYING'
  | 'PASSED'
  | 'MERGED'
  | 'STALE'
  | 'FAILED'
  | 'ESCALATED_1'
  | 'ESCALATED_2'
  | 'NEEDS_REPLAN'
  | 'CANCELLED'
  | 'ABANDONED';

// -- Worker exit taxonomy ----------------------------------------------------
// env_error is special: it does NOT count toward the escalation ladder.
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

// -- policy.yaml (human-maintained, read from the base_sha git object) ---------
/** An argv template; tokens like `{build_dir}` are filled from verification_params. */
export type WhitelistTemplate = string[];

/** A rolling-window token budget for one executor (used by budget-aware routing). */
export interface BudgetPolicy {
  window_minutes: number; // sliding window the budget is measured over (e.g. 300 = 5h)
  budget_tokens: number; // seed ceiling for the window (self-calibrated from observed limits)
  switch_at?: number; // fraction in (0,1]; skip this executor once projected use exceeds it (default 0.9)
}

export interface WorkerPolicy {
  kind: WorkerKind;
  api_key_env?: string; // env var to whitelist into the worker (plan-auth CLIs need none)
  model?: string; // pinned model slug passed to the worker (-m / --model); recorded in runs
  max_wall_minutes_default?: number;
  stall_minutes?: number;
  budget?: BudgetPolicy; // when set, routing proactively skips this executor near its ceiling
}

export interface ScopePolicy {
  forbidden_globs?: string[];
  test_globs?: string[];
  max_changed_lines: number;
}

// Budget ceilings evaluated against a task's accumulated metrics.jsonl spend.
// A run is refused once accumulated spend has reached (>=) any configured cap.
export interface BudgetCaps {
  max_cost_usd?: number;
  max_tokens?: number;
}

// Diff secret-scan tuning. Opt out with `enabled: false`; extend the conservative
// built-in patterns with `extra_patterns` (regex sources, matched on added lines).
export interface SecretScanPolicy {
  enabled?: boolean;
  extra_patterns?: string[];
}

export interface Policy {
  schema_version: 1;
  max_concurrent_workers?: number;
  worker?: WorkerPolicy; // single executor (back-compat); `workers` takes precedence
  workers?: WorkerPolicy[]; // ordered fallback chain: try [0], on quota_exhausted try [1], ...
  quota_error_pattern?: string; // regex (source) matched against the worker log to detect quota hits
  scope: ScopePolicy;
  /** ref-name (e.g. "build", "test") -> allowed argv templates. */
  verification: Record<string, WhitelistTemplate[]>;
  escalation?: {
    max_attempts?: number; // hard cap on counting attempts per task
    /** A stronger/different executor used for the ESCALATED_2 "rescue" attempt.
     * If absent, the rescue falls back to the last executor in the chain. */
    rescue_worker?: WorkerPolicy;
  };
  budget_caps?: BudgetCaps; // hard cap on accumulated cost/tokens per task
  secret_scan?: SecretScanPolicy; // diff secret scanning (on by default)
  /** Per-model USD prices (per million tokens). Key is a model slug or "default". */
  pricing?: Record<string, { input_per_mtok: number; output_per_mtok: number }>;
  /** Budget-aware routing knobs. Routing is inert unless a worker declares a `budget`. */
  routing?: {
    estimate_tokens_default?: number; // per-task token estimate when there is no history yet
    calibration_alpha?: number; // EMA weight for learning budget from observed limits (default 0.5)
    calibration_margin?: number; // tokens subtracted from the learned ceiling as safety (default 0)
  };
}

// -- Approval gate (recorded when a high-risk task is approved for merge) -------
export interface ApprovalRecord {
  approved_at: string; // ISO-8601
  actor: string; // e.g. "cli:approve", "cli:merge"
  risk_reasons?: string[];
}

// -- task.yaml (machine contract; schema-validated; frozen at VALIDATED) -------
export interface TaskYaml {
  schema_version: 1;
  id: string;
  title: string;
  base_sha: string | null; // null until VALIDATE resolves & pins it (40-hex)
  max_wall_minutes: number;
  allowed_globs: string[];
  forbidden_globs?: string[];
  max_changed_lines?: number;
  build_ref: string;
  test_ref: string;
  verification_params?: Record<string, string>;
}

// -- Effective scope (task + policy, precomputed by the app layer) -------------
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

// -- Events, state, runs, metrics ----------------------------------------------
export interface EventRecord {
  seq: number; // monotonic per task, assigned under the global lock
  ts: string; // ISO-8601
  from: TaskState | null; // null for the initial 'created' event
  to: TaskState;
  actor: string; // e.g. "cli:validate", "supervisor", "recover"
  run_id: string | null;
  meta?: Record<string, unknown>;
}

export interface StateFile {
  schema_version: 1;
  id: string;
  state: TaskState;
  base_sha: string | null;
  contract_hash: string | null;
  current_run: string | null;
  attempt_number: number;
  title: string;
  updated_at: string;
  last_event_seq: number;
}

export interface Lease {
  run_id: string;
  task_id: string;
  attempt_number: number;
  supervisor_pid: number;
  supervisor_pgid?: number; // the detached _worker-run's process group (== its pid)
  worker_pgid: number;
  host: string;
  started_at: string;
  max_wall_minutes: number;
  wall_deadline: string;
  heartbeat_path: string;
}

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
  worker: { kind: WorkerKind; model?: string };
  executor_switches?: number; // times we fell back to the next executor (quota/env)
  tokens?: { input: number; output: number };
  cost_usd?: number;
  verifier?: VerifierReport;
  diff_sha?: string;
}

export interface RegistryEntry {
  state: TaskState;
  current_run: string | null;
  title: string;
  updated_at: string;
}

export interface Registry {
  schema_version: 1;
  rebuilt_at: string;
  tasks: Record<string, RegistryEntry>;
}

export interface MetricRecord {
  ts: string;
  task_id: string;
  run_id: string;
  attempt_number: number;
  model: string | null;
  executor?: WorkerKind | null; // which executor produced this run (for the rolling ledger)
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

// A recorded Opus-direct measurement, the denominator for savings. Populated by
// `router baseline add` from a task done directly by Opus (no router). Averaged
// into the baseline used by `router stats`.
export interface BaselineRecord {
  ts: string;
  task_id: string | null;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number | null;
  wall_seconds: number | null;
}

// A ground-truth "this executor hit its provider limit" observation, appended by a
// run when it is reclassified `quota_exhausted`. Budget self-calibration reads these
// (with the token ledger) to learn each executor's real ceiling. Append-only.
export interface RoutingObservation {
  ts: string;
  kind: WorkerKind; // the executor that hit its limit
  task_id: string;
  run_id: string;
}

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
