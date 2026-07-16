// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type {
  DiffEntry,
  EffectiveScope,
  ScopeVerdict,
  ScopeViolation,
} from '../domain/types.ts';
import { matchAny } from './glob.ts';

// Diff-side scope enforcement. This is the SOLE point where "what may this task
// touch" is enforced - the worker prompt's scope is only guidance. PURE: consumes
// an already-parsed diff (from io/git) and a precomputed EffectiveScope.
//
// Rules (see design section 10 / D11):
//   - empty diff              => fail (nothing was produced)
//   - a changed path not in allowed_globs (and any forbidden match) => fail
//   - for renames/copies, BOTH old and new paths must satisfy scope
//   - deleting a file matching test_globs => fail (no silently removing tests)
//   - total added+deleted over non-binary files > max_changed_lines => fail
//     (binaries are still scope-checked but excluded from the line count)

function pathsToCheck(entry: DiffEntry): string[] {
  return entry.oldPath !== undefined ? [entry.oldPath, entry.path] : [entry.path];
}

export function evaluateScope(changes: readonly DiffEntry[], scope: EffectiveScope): ScopeVerdict {
  const violations: ScopeViolation[] = [];

  if (changes.length === 0) {
    return {
      ok: false,
      changedLines: 0,
      violations: [{ kind: 'empty_diff', detail: 'diff is empty - worker produced no changes' }],
    };
  }

  let changedLines = 0;

  for (const entry of changes) {
    for (const p of pathsToCheck(entry)) {
      if (matchAny(p, scope.forbidden_globs)) {
        violations.push({ kind: 'forbidden', path: p, detail: `path matches a forbidden glob` });
      } else if (!matchAny(p, scope.allowed_globs)) {
        violations.push({ kind: 'not_allowed', path: p, detail: `path is outside allowed_globs` });
      }
    }

    // A test is "removed" either by deletion, or by renaming it OUT of test_globs
    // (which would otherwise silently escape the delete guard).
    const deletesTest = entry.status === 'D' && matchAny(entry.path, scope.test_globs);
    const renamesTestAway =
      entry.status === 'R' &&
      entry.oldPath !== undefined &&
      matchAny(entry.oldPath, scope.test_globs) &&
      !matchAny(entry.path, scope.test_globs);
    if (deletesTest || renamesTestAway) {
      violations.push({
        kind: 'test_deletion',
        path: entry.oldPath ?? entry.path,
        detail: 'removes a file matching test_globs',
      });
    }

    if (!entry.binary) changedLines += entry.added + entry.deleted;
  }

  if (changedLines > scope.max_changed_lines) {
    violations.push({
      kind: 'max_lines',
      detail: `changed ${changedLines} lines > max ${scope.max_changed_lines}`,
    });
  }

  return { ok: violations.length === 0, changedLines, violations };
}
