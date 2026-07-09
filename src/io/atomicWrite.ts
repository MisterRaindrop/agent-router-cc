// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// Atomic file replace: write a temp file IN THE SAME DIRECTORY (so rename is a
// same-filesystem move, hence atomic), fsync it, then rename over the target.
// A crash mid-write leaves either the old file or nothing - never a torn file.

let counter = 0;

function tmpPath(target: string): string {
  // pid + monotonic counter keeps concurrent writers in the same process distinct;
  // Math.random avoided (forbidden in tests' spirit) - counter suffices here.
  counter += 1;
  return join(dirname(target), `.tmp.${process.pid}.${counter}.${target.length}`);
}

export function writeFileAtomic(target: string, data: string | Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = tmpPath(target);
  const fd = openSync(tmp, 'wx'); // wx: fail if the temp name somehow exists
  try {
    writeSync(fd, data as never);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/** Atomically write a pretty-printed JSON document with a trailing newline. */
export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}
