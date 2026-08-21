#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that scopes its edit and session id to the task it was given.
//
// The task id comes from the prompt, which carries `task: <id>` in the delivery-report block it
// tells the executor to emit. It used to come from the cwd path instead -- that worked only
// while each task ran in `.router/worktrees/<id>/run-001`, and silently produced garbage once
// the cwd became the shared repository root.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitUnit } from './fakeCommit.mjs';

const prompt = process.argv.slice(2).find((arg) => /^task: \S+$/m.test(arg)) ?? '';
const id = /^task: (\S+)$/m.exec(prompt)?.[1];
if (id === undefined) {
  process.stderr.write('fakeCodexScoped could not find "task: <id>" in its prompt\n');
  process.exit(9);
}
mkdirSync('src', { recursive: true });
writeFileSync(join('src', `${id}.ts`), `export const task = '${id}'; // edited by fake codex\n`);
commitUnit(`fake: unit for ${id}`, [join('src', `${id}.ts`)]);

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: `fake-session-${id}` }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
