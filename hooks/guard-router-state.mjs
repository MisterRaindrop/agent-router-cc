#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// PreToolUse guard: refuse direct edits to router-managed state files under
// .router/. The deterministic CLI is the ONLY writer of state - an agent editing
// result.json / metrics.jsonl / DELIVERY.md etc. would corrupt (or forge) the
// source of truth. Exit 2 blocks the tool call.
//
// What is allowed is decided by WHERE a file sits, not by a list of names: a
// name list silently blocks the next artifact the workflow introduces, which is
// exactly what happened to TASK_CONTEXT.md and gate.yaml - both are files the
// orchestrator is instructed to author, and both were refused. So:
//
//   .router/<name>.md, gate.yaml, models.yaml, policy.yaml  -> authored config/notes
//   .router/tasks/<id>/task.yaml and .router/tasks/<id>/*.md -> the contract
//   .router/plans/<id>/**.md                                 -> plan, critiques, decisions
//   .router/worktrees/**                                     -> the executor's working copy
//
// Everything else stays protected, and the boundary is deliberate: a run's own
// directory (.router/tasks/<id>/runs/**) holds the CLI's record of what actually
// happened - the diff, the verifier result, the executor's delivery report - so
// nothing there is editable even though DELIVERY.md is a .md file.
import { readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no input - nothing to guard
}

let data = {};
try {
  data = JSON.parse(raw || '{}');
} catch {
  process.exit(0);
}

const ti = data.tool_input ?? {};
const target = String(ti.file_path ?? ti.path ?? ti.notebook_path ?? '').replaceAll('\\', '/');
if (target === '') process.exit(0);

const inRouter = target.startsWith('.router/') || target.includes('/.router/');
if (!inRouter) process.exit(0);

// Worktrees under .router/worktrees/ are isolated repo checkouts that executors
// legitimately edit - they are the working copy, not router-managed state. Allow
// them; only real state files elsewhere under .router/ (e.g. .router/tasks/**)
// are protected. Without this, dispatch fails because the worktree itself lives
// under .router/, so every executor Write to its own checkout is blocked.
//
// DEAD while the branch execution model is in use: executors work in the repository root now,
// so nothing writes under .router/worktrees/ and this branch is never taken. Kept for the
// rollback window (see DEPRECATIONS.md) rather than deleted, because deleting it would silently
// break the fallback it exists for.
if (target.startsWith('.router/worktrees/') || target.includes('/.router/worktrees/')) process.exit(0);

const ROOT_EDITABLE = new Set(['gate.yaml', 'models.yaml', 'policy.yaml']);
const rel = target.slice(target.lastIndexOf('.router/') + '.router/'.length);
const parts = rel.split('/').filter((p) => p !== '');
const base = parts.at(-1) ?? '';
const isMarkdown = base.toLowerCase().endsWith('.md');

// Configuration and notes the human or the orchestrator authors, at the top level.
if (parts.length === 1 && (isMarkdown || ROOT_EDITABLE.has(base))) process.exit(0);
// The task contract: task.yaml plus TASK_CONTRACT.md / TASK_CONTEXT.md. Exactly one
// level below tasks/<id>, which is what keeps runs/** out.
if (parts.length === 3 && parts[0] === 'tasks' && (base === 'task.yaml' || isMarkdown)) {
  process.exit(0);
}
// Plan artifacts: PLAN.md, each round's critique, the decision record.
if (parts.length >= 3 && parts[0] === 'plans' && isMarkdown) process.exit(0);

process.stderr.write(
  `router: refusing to edit managed state under .router/ (${base}). ` +
    `State is owned by the router CLI; use \`router\` verbs instead of editing files directly.\n`,
);
process.exit(2);
