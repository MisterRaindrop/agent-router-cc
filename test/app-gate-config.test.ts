// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateYamlPath, loadGateConfig } from '../src/app/gateConfig.ts';
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
