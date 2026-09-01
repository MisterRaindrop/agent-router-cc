// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { drainGroupSync } from './signals.ts';

// Whitelisted command execution. argv array, shell:false - nothing is ever
// interpreted by a shell, so there are no pipes, redirects, globbing, or
// substitution. A command needing a pipeline must be a checked-in script that
// is itself whitelisted in policy.yaml.

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** How long to wait for the command's process group to empty, per signal. */
  reapGraceMs?: number;
}

export interface RunResult {
  rc: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  /**
   * The command's process group outlived SIGKILL, so something is still able to write this
   * checkout. Never a statement about the code under test: it means the result cannot be trusted
   * and the caller must not hand the working tree to anyone else.
   */
  groupSurvived: boolean;
}

/** Per signal, so the worst case is twice this. Long enough for a build to flush and exit. */
const DEFAULT_REAP_GRACE_MS = 5_000;

/**
 * `detached` IS honoured by spawnSync at runtime -- verified: the child's pgid comes back equal to
 * its own pid -- but it is absent from spawnSync's documented option list and so from the types.
 * Spread through an untyped object rather than casting the whole options bag, which would also
 * erase the `encoding: 'utf8'` overload and hand back Buffers. `io-proc.test.ts` fails if a node
 * release ever stops honouring it, because without a group of its own the drain below reaches the
 * direct child and nothing else -- which is the bug, silently back.
 */
const DETACHED: Record<string, unknown> = { detached: true };

export function runCommand(argv: readonly string[], opts: RunOptions): RunResult {
  if (argv.length === 0) {
    return {
      rc: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: 'empty argv',
      groupSurvived: false,
    };
  }
  const [cmd, ...args] = argv;
  // `detached` so the command leads its OWN process group and the drain below can reach the whole
  // tree. spawnSync's `timeout` kills the direct child only: `npm`, `make`, `cmake` and every test
  // runner spawn their own children, and those kept running after a gate reported FAILED --
  // measured, `timedOut: true` with the grandchild still alive. dispatch releases the checkout lock
  // immediately afterwards, on the stated invariant that no writer is left in the tree.
  //
  // The cost of `detached`, stated because it is real: the command no longer shares router's
  // process group, so a signal sent to that group does not reach it. This is the same trade the
  // executor already makes in io/supervisor.ts -- there is no way to signal a child's descendants
  // without first giving them a group of their own to signal.
  const r = spawnSync(cmd!, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferBytes ?? 64 * 1024 * 1024,
    killSignal: 'SIGKILL',
    ...DETACHED,
  });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnError =
    r.error !== undefined && !timedOut ? (r.error.message ?? String(r.error)) : null;
  // Runs on every path, not just the timeout: a command that exits while its own children are
  // still working leaves the same writers behind, and it is not a timeout. On the ordinary path
  // the group is already empty, so this costs one signal-0 and returns.
  const drained =
    typeof r.pid === 'number'
      ? drainGroupSync(r.pid, opts.reapGraceMs ?? DEFAULT_REAP_GRACE_MS)
      : { survived: false };
  return {
    rc: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut,
    spawnError,
    groupSurvived: drained.survived,
  };
}
