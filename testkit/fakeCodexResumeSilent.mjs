#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for a resume that dies before the session starts: it reports NO session id and
// exits non-zero, which is what a real `codex exec resume` does when handed a flag it does
// not accept. Absence of an id is not proof of re-attachment, so nothing may be committed.
import { writeFileSync } from 'node:fs';
import { commitUnit } from './fakeCommit.mjs';

const argv = process.argv.slice(2);
if (argv[0] === 'exec' && argv[1] === 'resume') {
  process.stderr.write("error: unexpected argument '-C' found\n");
  process.exit(2);
}

writeFileSync('src/a.ts', 'export const x = 2; // edited by fake codex\n');
commitUnit('fake: unit a', ['src/a.ts']);
process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: 'fake-session-1' }) + '\n');
process.stdout.write(
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 } }) + '\n',
);
process.exit(0);
