#!/usr/bin/env node
// Stand-in for codex-cli used by the CLI e2e test (ROUTER_CODEX_BIN). Ignores its
// args (prompt, -C, flags), makes an in-scope edit in its cwd (the worktree), and
// emits a JSONL usage line like `codex exec --json` would.
import { writeFileSync } from 'node:fs';

writeFileSync('src/a.ts', 'export const x = 2; // edited by fake codex\n');
// Mirror codex exec --json: a thread.started (carrying a model, future-proofing the
// model parser) and a turn.completed carrying token usage.
process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1' }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
