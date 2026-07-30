#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that cannot finish until all expected task executors have
// started. A sequential dispatcher times out here instead of accidentally passing.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const id = basename(dirname(process.cwd()));
const barrierDir = process.env.ROUTER_TEST_BARRIER_DIR;
const barrierCount = Number(process.env.ROUTER_TEST_BARRIER_COUNT ?? '2');
if (!barrierDir || !Number.isInteger(barrierCount) || barrierCount < 1) {
  process.stderr.write('fakeCodexBarrier needs ROUTER_TEST_BARRIER_DIR and a positive ROUTER_TEST_BARRIER_COUNT\n');
  process.exit(2);
}

mkdirSync(barrierDir, { recursive: true });
writeFileSync(join(barrierDir, `${id}.marker`), '');
const deadline = Date.now() + 20_000;
while (readdirSync(barrierDir).filter((name) => name.endsWith('.marker')).length < barrierCount) {
  if (Date.now() >= deadline) {
    process.stderr.write(`barrier timeout for ${id}: expected ${barrierCount} markers\n`);
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
