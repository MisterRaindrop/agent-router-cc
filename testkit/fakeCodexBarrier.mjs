#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that cannot finish until a SECOND task executor has also
// started: it drops a marker, then waits for another one to appear. A sequential
// dispatcher never clears that barrier, so it times out instead of passing by
// accident -- which is what makes the batch-dispatch test evidence of real overlap
// rather than of a loop.
//
// The expected marker count is fixed at two on purpose. The executor environment is
// a strict allowlist (io/env.ts), so the only variable this fake can be handed is
// the one the task names in `worker.api_key_env` -- here the barrier directory. A
// count read from an unreachable variable would silently fall back to its default
// and quietly stop proving anything.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MARKERS_REQUIRED = 2;
const id = basename(dirname(process.cwd()));
const barrierDir = process.env.ROUTER_TEST_BARRIER_DIR;
if (!barrierDir) {
  process.stderr.write('fakeCodexBarrier needs ROUTER_TEST_BARRIER_DIR (pass it via the task worker.api_key_env)\n');
  process.exit(2);
}

mkdirSync(barrierDir, { recursive: true });
writeFileSync(join(barrierDir, `${id}.marker`), '');
const deadline = Date.now() + 20_000;
while (readdirSync(barrierDir).filter((name) => name.endsWith('.marker')).length < MARKERS_REQUIRED) {
  if (Date.now() >= deadline) {
    process.stderr.write(`barrier timeout for ${id}: no concurrent run appeared (need ${MARKERS_REQUIRED} markers)\n`);
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

mkdirSync('src', { recursive: true });
writeFileSync(join('src', `${id}.ts`), `export const task = '${id}'; // edited after barrier\n`);
process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: `fake-session-${id}` }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
process.exit(0);
