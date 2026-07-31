// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { ExitClass } from '../domain/types.ts';

// Classify how a worker run ended. env_error is deliberately its own class: it
// means the environment was wrong (codex missing, auth absent) rather than the
// task failing, and the escalation ladder must NOT count it as an attempt. PURE.

export interface SupervisionObservation {
  spawnError: boolean; // the worker binary couldn't be launched
  timedOut: boolean; // we killed it for exceeding max_wall
  stalled: boolean; // we killed it for making no progress
  killedByUs: boolean; // external cancel
  exitCode: number | null;
  signal: string | null; // signal it died from (if any)
}

export function classifyExit(o: SupervisionObservation): ExitClass {
  if (o.spawnError) return 'env_error';
  if (o.timedOut) return 'timeout';
  if (o.stalled) return 'stalled';
  if (o.killedByUs) return 'killed';
  if (o.signal !== null) return 'worker_crash';
  if (o.exitCode === 0) return 'ok';
  return 'task_failed';
}

/** Setup/quota failures and a correct contract refusal do not burn a task attempt. */
export function countsAsAttempt(exitClass: ExitClass): boolean {
  return exitClass !== 'env_error' && exitClass !== 'quota_exhausted' && exitClass !== 'contract_conflict';
}

/**
 * The executor reports a contract/code contradiction by putting this protocol marker
 * on the first non-empty line. Later mentions are ordinary prose, not state transitions.
 */
export function detectContractConflict(finalMessage: string | null | undefined): boolean {
  if (finalMessage == null) return false;
  const first = finalMessage.split(/\r?\n/).find((line) => line.trim() !== '');
  if (first === undefined) return false;
  return /^CONTRACT_CONFLICT(?:[^\p{L}\p{N}\s]+)?$/u.test(first.trim());
}

/**
 * The worker log is not all *about* the worker: it relays whole command transcripts and file
 * contents from the work the executor did. Classifying on that text is unsound -- this
 * project's own sources and test names contain "quota" and "unknown model", so an executor
 * that merely ran the test suite and then failed would be reclassified as a provider quota
 * hit or a stale model config. (Both were observed on a real run.)
 *
 * So keep only what the executor said about *itself*: raw non-JSON diagnostic lines, plus
 * JSON events that are not relayed content. A provider failure arrives as a raw `ERROR: {...}`
 * line (observed) and therefore survives this filter, while codex `item.*` events and claude
 * `assistant`/`user` events -- command output, file diffs, tool results, model prose -- do not.
 *
 * Erring this way is the safe direction: missing a real quota hit costs one re-dispatch,
 * whereas inventing one silently switches executors and does not count as an attempt. PURE.
 */
export function executorDiagnostics(logText: string): string {
  const kept: string[] = [];
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    if (!t.startsWith('{')) {
      kept.push(line); // raw stderr/stdout: this is where provider errors show up
      continue;
    }
    let type: unknown;
    try {
      type = (JSON.parse(t) as { type?: unknown }).type;
    } catch {
      kept.push(line); // not valid JSON after all -> treat as raw text
      continue;
    }
    if (typeof type === 'string' && (type.startsWith('item.') || type === 'assistant' || type === 'user')) {
      continue; // relayed content, not a statement about the executor
    }
    kept.push(line);
  }
  return kept.join('\n');
}

// Default signatures for a provider rate-limit / quota exhaustion in the worker log.
// Conservative so ordinary failures (a failing test, `exit 1`) are NOT reclassified.
export const DEFAULT_QUOTA_PATTERN =
  '\\b(rate.?limit|rate_limited|usage limit|usage_limit_reached|quota|insufficient_quota|too many requests|429)\\b';

/**
 * A worker that "failed" may actually have hit the provider's quota/rate limit.
 * If the exit looks like a plain failure/crash AND the log matches the quota
 * pattern, reclassify as quota_exhausted (so it triggers fallback, not an attempt).
 * PURE.
 */
export function reclassifyQuota(
  exitClass: ExitClass,
  logText: string,
  pattern: string = DEFAULT_QUOTA_PATTERN,
): ExitClass {
  if (exitClass !== 'task_failed' && exitClass !== 'worker_crash') return exitClass;
  return new RegExp(pattern, 'i').test(executorDiagnostics(logText)) ? 'quota_exhausted' : exitClass;
}

// Provider authentication failures are environment/setup failures, not evidence
// that the coding task was attempted and failed.
export const DEFAULT_ENV_ERROR_PATTERN =
  '\\b(not logged in|please run /login|authentication[_ -]?failed|failed to authenticate|invalid api key|no api key found|oauth token expired)\\b';

export function reclassifyEnvironmentFailure(
  exitClass: ExitClass,
  logText: string,
  pattern: string = DEFAULT_ENV_ERROR_PATTERN,
): ExitClass {
  if (exitClass !== 'task_failed' && exitClass !== 'worker_crash') return exitClass;
  return new RegExp(pattern, 'i').test(executorDiagnostics(logText)) ? 'env_error' : exitClass;
}

// A configured model slug the executor rejects: the tier config is likely stale
// (provider updated its lineup, or the plan lacks that tier). Detected so the CLI
// can warn the user to edit .router/models.yaml -- never auto-changed. PURE.
export const DEFAULT_MODEL_MISMATCH_PATTERN =
  '\\b(unknown model|model not found|no such model|model[^\\n]{0,40}?not (found|available|supported)|invalid model|unsupported model|unrecognized model)\\b';

export function detectModelMismatch(
  logText: string,
  pattern: string = DEFAULT_MODEL_MISMATCH_PATTERN,
): boolean {
  return new RegExp(pattern, 'i').test(executorDiagnostics(logText));
}
