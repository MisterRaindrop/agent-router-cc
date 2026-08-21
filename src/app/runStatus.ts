// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExitClass, RunPhase, RunPhaseTimings, RunStatus, RunTerminalState, WorkerKind } from '../domain/types.ts';
import { writeJsonAtomic } from '../io/atomicWrite.ts';
import type { Clock } from '../io/clock.ts';

const ACTIVITY_THROTTLE_MS = 2_000;
const LOG_POLL_MS = 250;
const SUBCOMMAND_PROGRAMS = new Set([
  'cargo',
  'docker',
  'git',
  'gh',
  'glab',
  'go',
  'npm',
  'npx',
  'pnpm',
  'router',
  'rustup',
  'swift',
  'yarn',
]);

const TIMING_KEY: Partial<Record<RunPhase, keyof RunPhaseTimings>> = {
  worktree: 't_worktree',
  executor_starting: 't_launch',
  executor_working: 't_exec',
  gating: 't_gate',
  verify: 't_verify',
};

export interface RunStatusOptions {
  path: string;
  workDir: string;
  budgetMinutes: number;
  clock: Clock;
  /** Test seam; production uses the frozen two-second lower bound. */
  activityThrottleMs?: number;
  /** Test seam for deterministic log-tail tests. */
  logPollMs?: number;
  /** Observability seam used only to count completed atomic writes in unit tests. */
  onWrite?: (status: Readonly<RunStatus>) => void;
}

/**
 * The dispatch-owned writer for one run's live status document. It never reads status.json;
 * its only input is dispatch lifecycle events and the executor's append-only log stream.
 */
export class RunStatusWriter {
  private readonly path: string;
  private readonly workDir: string;
  private readonly clock: Clock;
  private readonly activityThrottleMs: number;
  private readonly logPollMs: number;
  private readonly onWrite: ((status: Readonly<RunStatus>) => void) | undefined;
  private readonly durationsMs: RunPhaseTimings = {
    t_worktree: 0,
    t_launch: 0,
    t_exec: 0,
    t_gate: 0,
    t_verify: 0,
  };

  private status: RunStatus;
  private phaseStartedMonoMs: number;
  private lastActivityWriteMonoMs: number | null = null;
  private pendingActivity = false;
  private stallMs: number | null = null;
  private logPath: string | null = null;
  private logKind: WorkerKind | null = null;
  private logCharsRead = 0;
  private logTimer: NodeJS.Timeout | null = null;
  private terminalWritten = false;

  constructor(opts: RunStatusOptions) {
    this.path = opts.path;
    this.workDir = resolve(opts.workDir);
    this.clock = opts.clock;
    this.activityThrottleMs = opts.activityThrottleMs ?? ACTIVITY_THROTTLE_MS;
    this.logPollMs = opts.logPollMs ?? LOG_POLL_MS;
    this.onWrite = opts.onWrite;
    const now = this.clock.nowIso();
    this.phaseStartedMonoMs = this.clock.monotonicMs();
    this.status = {
      phase: 'queued',
      started_at: now,
      phase_started_at: now,
      budget_minutes: opts.budgetMinutes,
      last_output_at: null,
      stall_deadline: null,
    };
    this.write();
  }

  transition(phase: RunPhase, stallMs?: number): void {
    if (this.terminalWritten) return;
    this.accountCurrentPhase();
    const now = this.clock.nowIso();
    this.status = {
      phase,
      started_at: this.status.started_at,
      phase_started_at: now,
      budget_minutes: this.status.budget_minutes,
      last_output_at: null,
      stall_deadline:
        phase === 'executor_starting' || phase === 'executor_working'
          ? deadline(now, stallMs ?? this.stallMs)
          : null,
      ...(this.status.recent_action !== undefined ? { recent_action: this.status.recent_action } : {}),
    };
    this.phaseStartedMonoMs = this.clock.monotonicMs();
    this.pendingActivity = false;
    this.stallMs = stallMs ?? this.stallMs;
    this.write();
  }

  executorStarting(stallMs: number): void {
    this.stopLogTail();
    this.stallMs = stallMs;
    this.transition('executor_starting', stallMs);
  }

  executorWorking(logPath: string, kind: WorkerKind, initialLogChars = 0): void {
    this.transition('executor_working', this.stallMs ?? undefined);
    this.logPath = logPath;
    this.logKind = kind;
    this.logCharsRead = initialLogChars;
    this.pollLog();
    this.logTimer = setInterval(() => this.pollLog(), this.logPollMs);
    this.logTimer.unref();
  }

  finishExecutor(): void {
    this.pollLog();
    this.stopLogTail();
  }

  /** Record a complete executor stream line. Exposed so redaction/throttling are unit-testable. */
  noteOutput(line: string, kind: WorkerKind): void {
    if (this.terminalWritten || this.status.phase !== 'executor_working') return;
    const now = this.clock.nowIso();
    this.status.last_output_at = now;
    this.status.stall_deadline = deadline(now, this.stallMs);
    if (kind === 'claude') {
      const action = recentClaudeAction(line, this.workDir);
      if (action !== undefined) this.status.recent_action = action;
    } else if (kind === 'codex') {
      const action = recentCodexAction(line);
      if (action !== undefined) this.status.recent_action = action;
    }
    this.pendingActivity = true;

    const monoNow = this.clock.monotonicMs();
    if (
      this.lastActivityWriteMonoMs === null ||
      monoNow - this.lastActivityWriteMonoMs >= this.activityThrottleMs
    ) {
      this.writeActivity(monoNow);
    }
  }

  terminal(terminalState: RunTerminalState): RunPhaseTimings {
    if (!this.terminalWritten) {
      this.finishExecutor();
      this.accountCurrentPhase();
      this.status.stall_deadline = null;
      this.status.terminal_state = terminalState;
      this.terminalWritten = true;
      this.pendingActivity = false;
      this.write();
    } else if (this.status.terminal_state !== terminalState) {
      // A later artifact/metrics write can still throw after normal execution completed.
      // The outer dispatch guard must be able to correct that handled exception to failed.
      this.status.terminal_state = terminalState;
      this.write();
    }
    return this.timings();
  }

  timings(): RunPhaseTimings {
    return {
      t_worktree: seconds(this.durationsMs.t_worktree),
      t_launch: seconds(this.durationsMs.t_launch),
      t_exec: seconds(this.durationsMs.t_exec),
      t_gate: seconds(this.durationsMs.t_gate),
      t_verify: seconds(this.durationsMs.t_verify),
    };
  }

  private accountCurrentPhase(): void {
    const key = TIMING_KEY[this.status.phase];
    const now = this.clock.monotonicMs();
    if (key !== undefined) this.durationsMs[key] += Math.max(0, now - this.phaseStartedMonoMs);
    this.phaseStartedMonoMs = now;
  }

  private writeActivity(monoNow: number): void {
    if (!this.pendingActivity) return;
    this.write();
    this.pendingActivity = false;
    this.lastActivityWriteMonoMs = monoNow;
  }

  private pollLog(): void {
    this.flushActivityIfDue();
    if (this.logPath === null || this.logKind === null) return;
    let text: string;
    try {
      text = readFileSync(this.logPath, 'utf8');
    } catch {
      return;
    }
    if (text.length < this.logCharsRead) this.logCharsRead = 0;
    const appended = text.slice(this.logCharsRead);
    const lastNewline = appended.lastIndexOf('\n');
    if (lastNewline < 0) return;
    this.logCharsRead += lastNewline + 1;
    for (const line of appended.slice(0, lastNewline).split('\n')) {
      if (line.trim() !== '') this.noteOutput(line, this.logKind);
    }
  }

  private flushActivityIfDue(): void {
    if (!this.pendingActivity || this.lastActivityWriteMonoMs === null) return;
    const monoNow = this.clock.monotonicMs();
    if (monoNow - this.lastActivityWriteMonoMs >= this.activityThrottleMs) {
      this.writeActivity(monoNow);
    }
  }

  private stopLogTail(): void {
    if (this.logTimer !== null) clearInterval(this.logTimer);
    this.logTimer = null;
    this.logPath = null;
    this.logKind = null;
    this.logCharsRead = 0;
  }

  private write(): void {
    writeJsonAtomic(this.path, this.status);
    this.onWrite?.({ ...this.status });
  }
}

const RUN_PHASES: ReadonlySet<string> = new Set<RunPhase>([
  'queued',
  'worktree',
  'executor_starting',
  'executor_working',
  'gating',
  'verify',
]);

const TERMINAL_STATES: ReadonlySet<string> = new Set<RunTerminalState>([
  'succeeded',
  'failed',
  'stalled',
  'timed_out',
  'cancelled',
]);

/**
 * Read one run's live status document, for reporters only -- the writer above never reads.
 * A run in flight has a status.json but no result.json yet, so this is the only way to see
 * its current phase. Absent, unreadable or off-protocol content yields null rather than an
 * exception: every caller is a read-only view that must degrade to what it showed before
 * status.json existed, never fail because one run's file is half-written or hand-edited.
 */
export function readRunStatus(path: string): RunStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  if (typeof parsed.phase !== 'string' || !RUN_PHASES.has(parsed.phase)) return null;
  if (typeof parsed.started_at !== 'string' || !Number.isFinite(Date.parse(parsed.started_at))) return null;
  const terminal = parsed.terminal_state;
  if (terminal !== undefined && (typeof terminal !== 'string' || !TERMINAL_STATES.has(terminal))) return null;
  return parsed as unknown as RunStatus;
}

export function terminalStateFor(exitClass: ExitClass, verifierPassed: boolean): RunTerminalState {
  if (exitClass === 'stalled') return 'stalled';
  if (exitClass === 'timeout') return 'timed_out';
  if (exitClass === 'killed') return 'cancelled';
  return exitClass === 'ok' && verifierPassed ? 'succeeded' : 'failed';
}

/** Extract only frozen-protocol allowlisted tool metadata from one Claude JSON event. */
export function recentClaudeAction(line: string, workDir: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const tools: Record<string, unknown>[] = [];
  collectToolUses(event, tools);
  let recent: string | undefined;
  for (const tool of tools) {
    const name = tool.name;
    const input = isRecord(tool.input) ? tool.input : {};
    if (name === 'Read' || name === 'Edit' || name === 'Write') {
      const rawPath = typeof input.file_path === 'string' ? input.file_path : input.path;
      if (typeof rawPath !== 'string') continue;
      const repoPath = repoRelativePath(rawPath, workDir);
      if (repoPath !== undefined) recent = `${name}: ${repoPath}`;
    } else if (name === 'Bash' && typeof input.command === 'string') {
      const tokens = bashTokens(input.command);
      recent = tokens.length === 0 ? 'Bash:' : `Bash: ${tokens.join(' ')}`;
    }
  }
  return recent;
}

/** Extract only allowlisted command metadata from one Codex JSON event. */
export function recentCodexAction(line: string): string | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(event) || (event.type !== 'item.started' && event.type !== 'item.completed')) {
    return undefined;
  }
  const item = event.item;
  if (!isRecord(item) || item.type !== 'command_execution' || typeof item.command !== 'string') {
    return undefined;
  }
  const command = unwrapShellCommand(item.command);
  if (command === undefined) return undefined;
  const tokens = bashTokens(command);
  return tokens.length === 0 ? 'Bash:' : `Bash: ${tokens.join(' ')}`;
}

function collectToolUses(value: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolUses(item, found);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'tool_use' && typeof value.name === 'string') found.push(value);
  for (const child of Object.values(value)) collectToolUses(child, found);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function repoRelativePath(rawPath: string, workDir: string): string | undefined {
  const root = resolve(workDir);
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function bashTokens(command: string): string[] {
  const raw = command.trim().split(/\s+/u).filter(Boolean);
  const programAt = raw.findIndex((token) => !token.includes('=') && !isShellOperator(token));
  if (programAt < 0) return [];
  const program = raw[programAt]!;
  if (!safeToken(program)) return [];
  const tokens = [program];
  const subcommand = raw[programAt + 1];
  if (
    subcommand !== undefined &&
    SUBCOMMAND_PROGRAMS.has(basename(program)) &&
    !subcommand.startsWith('-') &&
    safeToken(subcommand) &&
    !isShellOperator(subcommand)
  ) {
    tokens.push(subcommand);
  }
  return tokens;
}

function unwrapShellCommand(command: string): string | undefined {
  const match = /^(\S+)[ \t]+(-lc|-c)[ \t]+([\s\S]+)$/u.exec(command.trim());
  if (match === null) return undefined;
  const shell = basename(match[1]!);
  const option = match[2]!;
  if (
    !((shell === 'zsh' || shell === 'bash') && option === '-lc') &&
    !(shell === 'sh' && option === '-c')
  ) {
    return undefined;
  }
  return unwrapQuotedShellWord(match[3]!);
}

function unwrapQuotedShellWord(word: string): string | undefined {
  const quote = word[0];
  if ((quote !== '"' && quote !== "'") || word.length < 2) return undefined;
  let unwrapped = '';
  for (let index = 1; index < word.length; index += 1) {
    const character = word[index]!;
    if (character === quote) return index === word.length - 1 ? unwrapped : undefined;
    if (quote === '"' && character === '\\') {
      const escaped = word[index + 1];
      if (escaped === undefined || escaped === '\n') return undefined;
      if (escaped === '"' || escaped === '\\' || escaped === '$' || escaped === '`') {
        unwrapped += escaped;
      } else {
        unwrapped += `\\${escaped}`;
      }
      index += 1;
    } else {
      unwrapped += character;
    }
  }
  return undefined;
}

function safeToken(token: string): boolean {
  return /^[A-Za-z0-9_./:@%+,-]+$/u.test(token) && !token.includes('=');
}

function isShellOperator(token: string): boolean {
  return token === '&&' || token === '||' || token === ';' || token === '|' || token === '>' || token === '<';
}

function deadline(nowIso: string, durationMs: number | null | undefined): string | null {
  if (durationMs == null) return null;
  return new Date(Date.parse(nowIso) + durationMs).toISOString();
}

function seconds(ms: number): number {
  return Math.round(ms) / 1_000;
}
