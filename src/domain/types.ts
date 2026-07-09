// Central domain types. Leaf module: imports nothing, imported by every ring.

// ── Task state machine ──────────────────────────────────────────────────────
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

// ── Worker exit taxonomy ────────────────────────────────────────────────────
// env_error is special: it does NOT count toward the escalation ladder.
export type ExitClass =
  | 'ok'
  | 'task_failed'
  | 'timeout'
  | 'stalled'
  | 'killed'
  | 'worker_crash'
  | 'env_error';

export type WorkerKind = 'codex'; // M2 adds 'sonnet' etc.

// ── policy.yaml (human-maintained, read from the base_sha git object) ─────────
/** An argv template; tokens like `{build_dir}` are filled from verification_params. */
export type WhitelistTemplate = string[];

export interface WorkerPolicy {
  kind: WorkerKind;
  api_key_env: string;
  max_wall_minutes_default?: number;
  stall_minutes?: number;
}

export interface ScopePolicy {
  forbidden_globs?: string[];
  test_globs?: string[];
  max_changed_lines: number;
}

export interface Policy {
  schema_version: 1;
  max_concurrent_workers?: number;
  worker?: WorkerPolicy;
  scope: ScopePolicy;
  /** ref-name (e.g. "build", "test") -> allowed argv templates. */
  verification: Record<string, WhitelistTemplate[]>;
  escalation?: { max_attempts?: number };
}

// ── task.yaml (machine contract; schema-validated; frozen at VALIDATED) ───────
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

// ── Effective scope (task ⊕ policy, precomputed by the app layer) ─────────────
// core/scope.ts consumes this so it stays pure and free of merge policy.
export interface EffectiveScope {
  allowed_globs: string[];
  forbidden_globs: string[];
  test_globs: string[];
  max_changed_lines: number;
}

// ── Parsed git diff entry (produced by io/git, consumed by core/scope) ────────
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

// ── Events, state, runs, metrics ──────────────────────────────────────────────
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
