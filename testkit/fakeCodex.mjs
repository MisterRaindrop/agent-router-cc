#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli used by the CLI e2e tests (ROUTER_CODEX_BIN). Makes an
// in-scope edit in its cwd (the worktree) and emits a JSONL stream like
// `codex exec --json` would, including a `thread_id` (session id).
//
// Resume: on `exec resume <session-id> <feedback>` it echoes the SAME session id
// back (proving re-attach) and makes a follow-up edit. See fakeCodexResumeMismatch.mjs
// for the not-re-attached case.
import { writeFileSync } from 'node:fs';
import { commitUnit } from './fakeCommit.mjs';

const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const sid = isResume ? (argv[2] ?? 'fake-session-1') : 'fake-session-1';

writeFileSync(
  'src/a.ts',
  isResume
    ? 'export const x = 3; // edited by fake codex (resumed)\n'
    : 'export const x = 2; // edited by fake codex\n',
);
commitUnit(isResume ? 'fake: follow-up unit' : 'fake: unit a', ['src/a.ts']);

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: sid }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
