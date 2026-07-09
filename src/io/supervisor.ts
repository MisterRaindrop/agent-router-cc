import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExitClass } from '../domain/types.ts';
import { classifyExit } from '../core/exitTaxonomy.ts';
import { killProcessGroup } from './signals.ts';

// Worker supervision. The worker is spawned as the leader of its OWN process
// group (detached) so we can kill the WHOLE group — worker + every child it
// spawned — without touching ourselves. We enforce a hard wall timeout and a
// stall watchdog (no log growth AND no worktree change), escalate SIGTERM→SIGKILL,
// and classify the exit. Worker output goes only to the log file (never our
// stdout), so the orchestrator's context stays clean.

export interface SuperviseSpec {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  heartbeatPath: string;
  watchDir: string; // worktree; its change is a liveness signal
  maxWallMs: number;
  stallMs: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  sigkillGraceMs?: number;
  /** Called once with the worker's process-group id (== worker pid) after spawn. */
  onPgid?: (pgid: number) => void;
}

export interface SupervisionOutcome {
  exitClass: ExitClass;
  rc: number | null;
  signal: string | null;
  timedOut: boolean;
  stalled: boolean;
  spawnError: string | null;
  startedAtMs: number;
  endedAtMs: number;
}

function activitySignal(logPath: string, watchDir: string): number {
  let sig = 0;
  try {
    sig += statSync(logPath).size;
  } catch {
    /* not created yet */
  }
  for (const p of [watchDir, join(watchDir, '.git')]) {
    try {
      sig += Math.floor(statSync(p).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return sig;
}

export function superviseWorker(spec: SuperviseSpec): Promise<SupervisionOutcome> {
  const heartbeatIntervalMs = spec.heartbeatIntervalMs ?? 20_000;
  const pollIntervalMs = spec.pollIntervalMs ?? 1_000;
  const sigkillGraceMs = spec.sigkillGraceMs ?? 10_000;

  return new Promise((resolve) => {
    mkdirSync(dirname(spec.logPath), { recursive: true });
    mkdirSync(dirname(spec.heartbeatPath), { recursive: true });
    const startedAtMs = Date.now();
    const logFd = openSync(spec.logPath, 'a');

    let timedOut = false;
    let stalled = false;
    let settled = false;
    let lastActivity = startedAtMs;
    let lastSignal = activitySignal(spec.logPath, spec.watchDir);

    const timers: NodeJS.Timeout[] = [];
    const clearAll = (): void => {
      for (const t of timers) clearInterval(t);
      for (const t of timers) clearTimeout(t);
    };

    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      detached: true, // worker becomes its own process-group leader
      stdio: ['ignore', logFd, logFd],
    });

    const finish = (o: Omit<SupervisionOutcome, 'exitClass' | 'startedAtMs' | 'endedAtMs'>): void => {
      if (settled) return;
      settled = true;
      clearAll();
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
      const exitClass = classifyExit({
        spawnError: o.spawnError !== null,
        timedOut: o.timedOut,
        stalled: o.stalled,
        killedByUs: false,
        exitCode: o.rc,
        signal: o.signal,
      });
      resolve({ ...o, exitClass, startedAtMs, endedAtMs: Date.now() });
    };

    child.on('error', (err) => {
      // Could not launch the worker at all (e.g. codex not installed).
      finish({ rc: null, signal: null, timedOut: false, stalled: false, spawnError: err.message });
    });

    child.on('exit', (code, signal) => {
      finish({ rc: code, signal, timedOut, stalled, spawnError: null });
    });

    const pgid = child.pid;
    if (pgid !== undefined) {
      spec.onPgid?.(pgid);

      const escalateKill = (): void => {
        killProcessGroup(pgid, 'SIGTERM');
        timers.push(setTimeout(() => killProcessGroup(pgid, 'SIGKILL'), sigkillGraceMs));
      };

      // Hard wall timeout.
      timers.push(
        setTimeout(() => {
          timedOut = true;
          escalateKill();
        }, spec.maxWallMs),
      );

      // Heartbeat.
      timers.push(
        setInterval(() => {
          try {
            writeFileSync(spec.heartbeatPath, `${Date.now()}\n`);
          } catch {
            /* ignore */
          }
        }, heartbeatIntervalMs),
      );

      // Stall watchdog.
      timers.push(
        setInterval(() => {
          const sig = activitySignal(spec.logPath, spec.watchDir);
          if (sig !== lastSignal) {
            lastSignal = sig;
            lastActivity = Date.now();
            return;
          }
          if (Date.now() - lastActivity >= spec.stallMs) {
            stalled = true;
            escalateKill();
          }
        }, pollIntervalMs),
      );

      // Initial heartbeat so recover sees a fresh file immediately.
      try {
        writeFileSync(spec.heartbeatPath, `${startedAtMs}\n`);
      } catch {
        /* ignore */
      }
    }
  });
}
