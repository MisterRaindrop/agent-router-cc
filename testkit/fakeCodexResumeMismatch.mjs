#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Like fakeCodex.mjs, but on resume it reports a DIFFERENT session id than the one
// it was asked to resume -- simulating an executor that did NOT re-attach to the
// prior session. Used to test `router resume`'s fail-loud continuity guard.
import { writeFileSync } from 'node:fs';
import { commitUnit } from './fakeCommit.mjs';

const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const sid = isResume ? 'fake-session-DIFFERENT' : 'fake-session-1';

writeFileSync(
  'src/a.ts',
  isResume
    ? 'export const x = 3; // edited by fake codex (wrong session)\n'
    : 'export const x = 2; // edited by fake codex\n',
);
// Committed either way: the point of this fake is the session id, and the run must otherwise
// look normal so the continuity guard is what fails rather than the closing invariant.
commitUnit(isResume ? 'fake: follow-up under a different session' : 'fake: unit a', ['src/a.ts']);

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: sid }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
