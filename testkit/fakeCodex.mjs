#!/usr/bin/env node
// Stand-in for codex-cli used by the CLI e2e test (ROUTER_CODEX_BIN). Ignores its
// args (prompt, -C, flags), makes an in-scope edit in its cwd (the worktree), and
// emits a JSONL usage line like `codex exec --json` would.
import { writeFileSync } from 'node:fs';

writeFileSync('src/a.ts', 'export const x = 2; // edited by fake codex\n');
process.stdout.write(JSON.stringify({ type: 'token_count', input_tokens: 12, output_tokens: 7 }) + '\n');
process.exit(0);
