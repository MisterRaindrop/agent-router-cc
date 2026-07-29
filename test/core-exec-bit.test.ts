// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirOf, extensionOf, findExecBitViolations } from '../src/core/execBit.ts';

const execMode = '100755';
const plainMode = '100644';
const siblings = (exec: number, plain: number): string[] => [
  ...Array<string>(exec).fill(execMode),
  ...Array<string>(plain).fill(plainMode),
];

test('flags a non-executable script added where siblings are executable', () => {
  const v = findExecBitViolations([
    { path: 'tests/queries/0_stateless/04900_new.sh', newMode: plainMode, siblingModes: siblings(30, 0) },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0]?.path, 'tests/queries/0_stateless/04900_new.sh');
  assert.equal(v[0]?.execSiblings, 30);
  assert.equal(v[0]?.totalSiblings, 30);
});

test('an executable new file is never a violation', () => {
  assert.deepEqual(
    findExecBitViolations([{ path: 'a/b.sh', newMode: execMode, siblingModes: siblings(30, 0) }]),
    [],
  );
});

test('a directory whose scripts are sourced (mostly non-executable) yields no opinion', () => {
  // The real-world false positive this rule must avoid: sourced shell libraries carry a
  // shebang but are deliberately not executable.
  assert.deepEqual(
    findExecBitViolations([{ path: 'tests/queries/helpers.sh', newMode: plainMode, siblingModes: siblings(1, 20) }]),
    [],
  );
});

test('too few siblings means no established convention', () => {
  assert.deepEqual(
    findExecBitViolations([{ path: 'a/new.sh', newMode: plainMode, siblingModes: siblings(2, 0) }]),
    [],
  );
  assert.equal(
    findExecBitViolations([{ path: 'a/new.sh', newMode: plainMode, siblingModes: siblings(3, 0) }]).length,
    1,
  );
});

test('threshold: 90% executable is a convention, less is not', () => {
  // 9/10 executable -> convention; 8/10 -> not.
  assert.equal(
    findExecBitViolations([{ path: 'a/new.sh', newMode: plainMode, siblingModes: siblings(9, 1) }]).length,
    1,
  );
  assert.equal(
    findExecBitViolations([{ path: 'a/new.sh', newMode: plainMode, siblingModes: siblings(8, 2) }]).length,
    0,
  );
});

test('no siblings at all -> no violation (new directory)', () => {
  assert.deepEqual(findExecBitViolations([{ path: 'a/new.sh', newMode: plainMode, siblingModes: [] }]), []);
});

test('extensionOf / dirOf', () => {
  assert.equal(extensionOf('tests/x/04900_a.sh'), '.sh');
  assert.equal(extensionOf('tests/x/Makefile'), '');
  assert.equal(extensionOf('.gitignore'), ''); // leading dot is not an extension
  assert.equal(extensionOf('a/b/c.test.ts'), '.ts');
  assert.equal(dirOf('tests/x/04900_a.sh'), 'tests/x');
  assert.equal(dirOf('top.sh'), '');
});
