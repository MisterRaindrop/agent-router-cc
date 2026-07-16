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
  max_wall_minutes_default?: number;
  stall_minutes?: number;
}

// -- task.yaml (machine contract; schema-validated) ----------------------------
export interface TaskYaml {
  schema_version: 1;
  id: string;
  title: string;
  base_sha: string | null; // null until a diff is produced against a base commit (40-hex)
  max_wall_minutes: number;
  allowed_globs: string[];
  forbidden_globs?: string[];
  max_changed_lines?: number;
  /** The mechanical verify command(s) run on the diff (argv arrays; [] = none). */
  verify?: string[][];
  /** Executor pinned for this task (kind + optional model); else quota-balanced default. */
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
  worker: { kind: WorkerKind; model?: string };
  executor_switches?: number; // times we fell back to the next executor (quota/env)
  tokens?: { input: number; output: number };
  cost_usd?: number;
  verifier?: VerifierReport;
  diff_sha?: string;
}

export interface MetricRecord {
  ts: string;
  task_id: string;
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
