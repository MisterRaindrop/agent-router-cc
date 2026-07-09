// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';

// Whitelisted command execution. argv array, shell:false - nothing is ever
// interpreted by a shell, so there are no pipes, redirects, globbing, or
// substitution. A command needing a pipeline must be a checked-in script that
// is itself whitelisted in policy.yaml.

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface RunResult {
  rc: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export function runCommand(argv: readonly string[], opts: RunOptions): RunResult {
  if (argv.length === 0) {
    return { rc: null, stdout: '', stderr: '', timedOut: false, spawnError: 'empty argv' };
  }
  const [cmd, ...args] = argv;
  const r = spawnSync(cmd!, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnError =
    r.error !== undefined && !timedOut ? (r.error.message ?? String(r.error)) : null;
  return {
    rc: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
    spawnError,
  };
}
