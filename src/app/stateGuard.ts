// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { RouterPaths } from '../io/paths.ts';

// Detection for Must NOT 11: "the executor must not write real .router/ orchestration state".
//
// ROUTER_EXECUTOR_SANDBOX only refuses a nested `router` CLI. It cannot stop an executor writing
// those files with a plain file API, a shell redirect, or its own editor tool -- and the review
// demonstrated exactly that: a fake executor created `.router/tasks/forged/result.json`, the
// dispatch still reported PASSED, the file stayed, and the committed diff showed only `src/a.ts`
// because `.router/` is gitignored and therefore invisible to every gate.
//
// Prevention would need the sandbox to exclude a subdirectory of its own writable root, which
// codex's `workspace-write` does not offer. So this enforces by DETECTION: fingerprint the state
// before launching the executor, compare after it exits, and fail the run on any difference. A
// detected violation is not as good as an impossible one, but it is enormously better than the
// silence it replaces.

/** Files the CLI itself legitimately writes for the run in progress, so they cannot be evidence. */
function isOwnRunArtifact(rel: string, ownTaskId: string): boolean {
  const parts = rel.split(sep);
  if (parts[0] === 'gate.lock') return true; // the heartbeat rewrites it every few seconds
  if (parts[0] === 'metrics.jsonl') return true; // appended when the run ends
  if (parts[0] === 'symbols') return true; // a regenerable cache, not orchestration state
  if (parts[0] === 'worktrees') return true; // deprecated path, not state
  if (parts[0] !== 'tasks' || parts[1] !== ownTaskId) return false;
  // Within our own task: status.json, heartbeat and logs/ are written continuously while the
  // executor runs. task.yaml and TASK_CONTRACT.md are NOT -- those are the contract, and an
  // executor rewriting its own contract mid-run is precisely what must be caught.
  const leaf = parts[2] ?? '';
  return leaf === 'status.json' || leaf === 'heartbeat' || leaf === 'logs';
}

/** `relative path -> size:mtimeMs` for every orchestration-state file that is not ours to write. */
export function fingerprintState(paths: RouterPaths, ownTaskId: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable: nothing to compare, and the run's own checks fail loudly
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(paths.root, abs);
      if (isOwnRunArtifact(rel, ownTaskId)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = statSync(abs);
        out.set(rel, `${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch {
        /* vanished between readdir and stat; the diff below reports it as removed */
      }
    }
  };
  walk(paths.root);
  return out;
}

/** What changed between two fingerprints, as human-readable lines. Empty means untouched. */
export function stateDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [rel, sig] of after) {
    const prior = before.get(rel);
    if (prior === undefined) changes.push(`created ${rel}`);
    else if (prior !== sig) changes.push(`modified ${rel}`);
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push(`deleted ${rel}`);
  return changes.sort();
}
