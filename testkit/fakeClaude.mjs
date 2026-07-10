#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for the claude CLI headless executor (ROUTER_CLAUDE_BIN). Ignores its
// args, makes an in-scope edit in its cwd (the worktree), and emits a
// stream-json `result` event like `claude -p --output-format stream-json`.
import { writeFileSync } from 'node:fs';

writeFileSync('src/a.ts', 'export const x = 2; // edited by fake claude\n');
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 800, output_tokens: 60, cache_read_input_tokens: 100 },
  }) + '\n',
);
process.exit(0);
