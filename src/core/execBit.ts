// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// The exec-bit rule: a script a project executes directly must carry the executable
// bit, or it dies with "permission denied" before a single assertion runs. An executor
// that creates the file without it produces a change that clears every other gate and
// still cannot run in CI -- a deterministic, environment-free mistake, so the CLI owns
// it (this module is the rule; the git lookups live in io/app).
//
// The rule is deliberately NOT "a script must be executable": plenty of shell files are
// meant to be *sourced*, never executed, and they carry a shebang too (measured on a
// large repo: 3032 executable `.sh` vs 14 non-executable, 13 of which had a shebang --
// a shebang-based rule would flag all of them). Instead the rule reads the convention
// of the directory the file was added to: if that directory's existing same-extension
// siblings are overwhelmingly executable, a new non-executable one is a mistake. A
// directory with no established convention yields no opinion.

const EXEC_MODE = '100755';
const NON_EXEC_MODE = '100644';

export interface ExecBitInput {
  path: string;
  /** git mode of the new blob, e.g. '100644'. */
  newMode: string;
  /** Modes of the same-extension siblings already in that directory at the base commit. */
  siblingModes: string[];
}

export interface ExecBitViolation {
  path: string;
  execSiblings: number;
  totalSiblings: number;
}

export interface ExecBitOptions {
  /** Below this many siblings a directory has no established convention. */
  minSiblings?: number;
  /** Share of executable siblings that makes "executable" the convention. */
  threshold?: number;
}

/**
 * Non-executable files added where the directory's convention is executable.
 * Pure: callers supply the sibling evidence.
 */
export function findExecBitViolations(
  inputs: ExecBitInput[],
  opts: ExecBitOptions = {},
): ExecBitViolation[] {
  const minSiblings = opts.minSiblings ?? 3;
  const threshold = opts.threshold ?? 0.9;
  const out: ExecBitViolation[] = [];
  for (const input of inputs) {
    if (input.newMode !== NON_EXEC_MODE) continue;
    const totalSiblings = input.siblingModes.length;
    if (totalSiblings < minSiblings) continue; // no convention to appeal to
    const execSiblings = input.siblingModes.filter((m) => m === EXEC_MODE).length;
    if (execSiblings / totalSiblings >= threshold) {
      out.push({ path: input.path, execSiblings, totalSiblings });
    }
  }
  return out;
}

/** The file extension used to group siblings ('' when there is none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/** Directory part of a repo-relative path ('' for a file at the repo root). */
export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
