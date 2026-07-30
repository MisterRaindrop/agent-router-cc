#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that scopes its edit and session id to the task worktree.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const id = basename(dirname(process.cwd()));
mkdirSync('src', { recursive: true });
writeFileSync(join('src', `${id}.ts`), `export const task = '${id}'; // edited by fake codex\n`);

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: `fake-session-${id}` }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
