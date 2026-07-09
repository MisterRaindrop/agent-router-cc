// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Child process used by the lock concurrency test. Acquires the global lock,
// writes BEGIN/END around a short critical section, then releases.
import { appendFileSync } from 'node:fs';
import { withGlobalLock } from '../src/io/lock.ts';

const [lockDir, marker, tag] = process.argv.slice(2);
if (!lockDir || !marker || !tag) {
  process.stderr.write('usage: lockWorker <lockDir> <markerFile> <tag>\n');
  process.exit(64);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

withGlobalLock(
  lockDir,
  () => {
    appendFileSync(marker, `BEGIN ${tag}\n`);
    sleepSync(40);
    appendFileSync(marker, `END ${tag}\n`);
  },
  { timeoutMs: 30_000, retryMs: 5 },
);
