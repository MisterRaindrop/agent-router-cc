// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateYamlPath, loadGateConfig, selectGate } from '../src/app/gateConfig.ts';
import type { DiffEntry, GateConfig } from '../src/domain/types.ts';
import { routerPaths } from '../src/io/paths.ts';

function freshPaths() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'router-gate-config-'));
  const paths = routerPaths(join(tempRoot, '.router'));
  return {
    paths,
    write(text: string): void {
      mkdirSync(paths.root, { recursive: true });
      writeFileSync(gateYamlPath(paths), text);
    },
    cleanup(): void {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test('loadGateConfig defaults only an absent file to worktree mode', () => {
  const fixture = freshPaths();
  try {
    assert.deepEqual(loadGateConfig(fixture.paths), { mode: 'worktree' });
  } finally {
    fixture.cleanup();
  }
});

test('loadGateConfig round-trips every queue configuration field', () => {
  const fixture = freshPaths();
  try {
    fixture.write(
      [
        'mode: queue',
        'integration_branch: router/integration',
        'gate:',
        '  - [npm, run, check]',
        '  - [node, scripts/smoke.mjs, --quick]',
        'clean_gate:',
        '  - [npm, run, clean-check]',
        'clean_triggers: [package.json, "scripts/**"]',
        'reset:',
        '  - [node, scripts/reset-db.mjs]',
        'lock_wait_minutes: 12.5',
        'env: [QUEUE_DATABASE_URL, QUEUE_FEATURE_FLAG]',
        'gate_wall_minutes: 45',
      ].join('\n'),
    );
    assert.deepEqual(loadGateConfig(fixture.paths), {
      mode: 'queue',
      integration_branch: 'router/integration',
      gate: [
        ['npm', 'run', 'check'],
        ['node', 'scripts/smoke.mjs', '--quick'],
      ],
      clean_gate: [['npm', 'run', 'clean-check']],
      clean_triggers: ['package.json', 'scripts/**'],
      reset: [['node', 'scripts/reset-db.mjs']],
      lock_wait_minutes: 12.5,
      env: ['QUEUE_DATABASE_URL', 'QUEUE_FEATURE_FLAG'],
      gate_wall_minutes: 45,
    });
  } finally {
    fixture.cleanup();
  }
});

test('loadGateConfig reports unreadable and unparseable files instead of defaulting', () => {
  const unreadable = freshPaths();
  try {
    mkdirSync(gateYamlPath(unreadable.paths), { recursive: true });
    assert.throws(() => loadGateConfig(unreadable.paths), /gate\.yaml is unreadable/);
  } finally {
    unreadable.cleanup();
  }

  const unparseable = freshPaths();
  try {
    unparseable.write('mode: [queue\n');
    assert.throws(() => loadGateConfig(unparseable.paths), /gate\.yaml parse error/);
  } finally {
    unparseable.cleanup();
  }
});

test('a broken gate.yaml symlink is unreadable, not absent', () => {
  const fixture = freshPaths();
  try {
    mkdirSync(fixture.paths.root, { recursive: true });
    symlinkSync(join(fixture.paths.root, 'missing-target.yaml'), gateYamlPath(fixture.paths));
    assert.throws(() => loadGateConfig(fixture.paths), /gate\.yaml is unreadable/);
  } finally {
    fixture.cleanup();
  }
});

test('loadGateConfig names invalid modes, unknown keys, and wrong field types', () => {
  const cases: Array<{ yaml: string; message: RegExp }> = [
    { yaml: 'mode: somewhere', message: /mode must be "worktree" or "queue"/ },
    { yaml: 'mode: worktree\nmystery: true', message: /unknown top-level key "mystery"/ },
    { yaml: 'mode: worktree\ngate: check', message: /gate must be an array of argv arrays/ },
    { yaml: 'mode: worktree\ngate: [[]]', message: /gate\[0\] must be a non-empty argv array/ },
    { yaml: 'mode: worktree\ngate: [[npm, ""]]', message: /gate\[0\]\[1\].*non-empty string/ },
    {
      yaml: 'mode: worktree\nclean_triggers: [package.json, 4]',
      message: /clean_triggers\[1\].*non-empty string/,
    },
    {
      yaml: 'mode: worktree\nlock_wait_minutes: forever',
      message: /lock_wait_minutes.*non-negative finite number/,
    },
    {
      yaml: 'mode: worktree\nenv: [QUEUE_DATABASE_URL, 4]',
      message: /env\[1\].*non-empty string/,
    },
    {
      yaml: 'mode: worktree\ngate_wall_minutes: 0',
      message: /gate_wall_minutes.*positive finite number/,
    },
  ];

  for (const [index, entry] of cases.entries()) {
    const fixture = freshPaths();
    try {
      fixture.write(entry.yaml);
      assert.throws(
        () => loadGateConfig(fixture.paths),
        entry.message,
        `validation case ${index} should name its problem`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('queue mode requires an integration branch and a non-empty gate', () => {
  const cases: Array<{ yaml: string; message: RegExp }> = [
    { yaml: 'mode: queue\ngate: [[npm, test]]', message: /integration_branch is required/ },
    {
      yaml: 'mode: queue\nintegration_branch: router/integration',
      message: /gate is required/,
    },
    {
      yaml: 'mode: queue\nintegration_branch: router/integration\ngate: []',
      message: /gate must contain at least one argv array/,
    },
  ];

  for (const entry of cases) {
    const fixture = freshPaths();
    try {
      fixture.write(entry.yaml);
      assert.throws(() => loadGateConfig(fixture.paths), entry.message);
    } finally {
      fixture.cleanup();
    }
  }
});

// --- selectGate (P7) ------------------------------------------------------------------
//
// Shared by the queue gate and by dispatch's own verification. It used to be written out inline
// inside the queue gate only, which is why dispatch -- claiming to have absorbed the queue's
// gate handling -- ran nothing but `task.verify`, leaving `clean_triggers` documented and dead.

const INCREMENTAL = [['make', 'test']];
const FULL = [['make', 'clean', 'test']];

function entry(path: string, status: DiffEntry['status'] = 'M', oldPath?: string): DiffEntry {
  return { path, status, added: 1, deleted: 0, binary: false, ...(oldPath !== undefined ? { oldPath } : {}) };
}

const CONFIG: GateConfig = {
  mode: 'queue',
  integration_branch: 'router/integration',
  gate: INCREMENTAL,
  clean_gate: FULL,
  clean_triggers: ['**/*.h', 'configure.ac'],
};

test('selectGate picks the incremental gate for an ordinary source change', () => {
  const picked = selectGate(CONFIG, [entry('src/exec.c')]);
  assert.deepEqual(picked, { level: 'task', commands: INCREMENTAL });
});

// Fault-injection case 8i.
test('selectGate escalates to the full gate when a clean trigger is touched (8i)', () => {
  assert.deepEqual(selectGate(CONFIG, [entry('src/nodes/plan.h')]), { level: 'clean', commands: FULL });
  assert.deepEqual(selectGate(CONFIG, [entry('configure.ac')]), { level: 'clean', commands: FULL });
  // One trigger among many ordinary files is still enough.
  assert.deepEqual(
    selectGate(CONFIG, [entry('src/a.c'), entry('src/b.c'), entry('include/api.h')]),
    { level: 'clean', commands: FULL },
  );
});

// The rule that is not about triggers at all: an incremental build can keep a stale object for a
// source file that no longer exists, and nothing in the diff tells it to drop it.
test('selectGate escalates for any deletion, trigger or not', () => {
  assert.deepEqual(selectGate(CONFIG, [entry('src/gone.c', 'D')]), { level: 'clean', commands: FULL });
});

// A rename moves a file out of one path and into another; if the ORIGIN was a trigger, the build
// still has to forget it, so both ends are checked.
// A renamed path stops existing exactly as a deleted one does, and the object file for the old
// name survives an incremental build. Measured against real ClickHouse commits before this existed:
// a diff whose only status was `R` came back `task`.
test('selectGate escalates for a rename, because the old path is gone too', () => {
  const config: GateConfig = {
    mode: 'queue',
    integration_branch: 'main',
    gate: [['ninja', '-C', 'build']],
    clean_gate: [['cmake', '--fresh', '-B', 'build']],
    clean_triggers: ['cmake/**'],
  };
  // Neither end matches a trigger: the escalation has to come from the rename itself.
  const withinADirectory = selectGate(config, [
    entry('src/Core/New.cpp', 'R', 'src/Core/Old.cpp'),
  ]);
  assert.equal(withinADirectory?.level, 'clean');
  const acrossDirectories = selectGate(config, [
    entry('src/B/Thing.cpp', 'R', 'src/A/Thing.cpp'),
  ]);
  assert.equal(acrossDirectories?.level, 'clean');
  // ...and an ordinary edit beside it is still not enough on its own.
  assert.equal(selectGate(config, [entry('src/Core/Settings.cpp')])?.level, 'task');
});

test('selectGate checks both ends of a rename', () => {
  assert.deepEqual(
    selectGate(CONFIG, [entry('src/renamed.c', 'R', 'include/old.h')]),
    { level: 'clean', commands: FULL },
  );
});

test('selectGate stays incremental when no clean_gate is configured at all', () => {
  const noClean: GateConfig = { mode: 'queue', integration_branch: 'i', gate: INCREMENTAL, clean_triggers: ['**/*.h'] };
  assert.deepEqual(selectGate(noClean, [entry('a.h', 'D')]), { level: 'task', commands: INCREMENTAL });
});

// null is the caller's signal to fall back to whatever the task carries -- which is what keeps
// every project WITHOUT a gate.yaml behaving exactly as it did.
test('selectGate returns null when the config declares no gate commands', () => {
  assert.equal(selectGate({ mode: 'worktree' }, [entry('src/a.ts')]), null);
  assert.equal(selectGate({ mode: 'worktree', gate: [] }, [entry('src/a.ts')]), null);
});
