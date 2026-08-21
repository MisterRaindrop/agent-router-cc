#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that adds a *script* to the repo, used to exercise the
// exec_bit gate end to end. It adds `tests/sh/new.sh`, and gives it the executable bit
// only when the fixture repo carries the marker file `tests/sh/.want-exec`.
//
// The marker is a committed file, not an env var, on purpose: router strips unknown
// variables from the executor's environment (allow-list), so an env-based switch would
// silently never arrive -- which is exactly how the first version of this fake fooled
// its own test into reporting a gate failure.
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { commitUnit } from './fakeCommit.mjs';

writeFileSync('tests/sh/new.sh', '#!/bin/sh\necho new\n');
if (existsSync('tests/sh/.want-exec')) chmodSync('tests/sh/new.sh', 0o755);
commitUnit('fake: add a test script', ['tests/sh/new.sh']);

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: 'fake-session-1' }) + '\n');
process.stdout.write(
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }) + '\n',
);
process.exit(0);
