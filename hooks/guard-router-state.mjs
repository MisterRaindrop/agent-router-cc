#!/usr/bin/env node
// PreToolUse guard: refuse direct edits to router-managed state files under
// .router/. The deterministic CLI is the ONLY writer of state — an agent editing
// state.json / events.jsonl / registry.json etc. would corrupt the source of
// truth. Human/agent-editable contract files (task.yaml, TASK_CONTRACT.md,
// PLAN.md, policy.yaml) are allowed. Exit 2 blocks the tool call.
import { readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no input — nothing to guard
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

const EDITABLE = new Set(['task.yaml', 'TASK_CONTRACT.md', 'PLAN.md', 'policy.yaml']);
const base = target.split('/').pop() ?? '';
if (EDITABLE.has(base)) process.exit(0);

process.stderr.write(
  `router: refusing to edit managed state under .router/ (${base}). ` +
    `State is owned by the router CLI; use \`router\` verbs instead of editing files directly.\n`,
);
process.exit(2);
