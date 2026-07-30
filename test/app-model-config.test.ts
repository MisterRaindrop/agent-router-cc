// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPaths } from '../src/io/paths.ts';
import {
  DEFAULT_MODEL_CONFIG,
  loadModelConfig,
  modelsYamlPath,
  tierWorkers,
} from '../src/app/modelConfig.ts';

function freshPaths() {
  const root = join(mkdtempSync(join(tmpdir(), 'router-mc-')), '.router');
  return { paths: routerPaths(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('loadModelConfig falls back to the bundled default when no models.yaml exists', () => {
  const { paths, cleanup } = freshPaths();
  try {
    const cfg = loadModelConfig(paths);
    assert.deepEqual(cfg, DEFAULT_MODEL_CONFIG);
    assert.equal(cfg.codex.weak.model, 'gpt-5.6-terra');
    assert.equal(cfg.codex.strong.effort, 'max');
    assert.equal(cfg.review[0]?.kind, 'codex');
    // Reviewers default to xhigh, not max: reliable + fast enough for review's breadth-
    // of-judgment nature; max is an explicit opt-in escalation (run in the background).
    assert.equal(cfg.review[0]?.effort, 'xhigh');
    assert.equal(cfg.review[1]?.effort, 'xhigh');
  } finally {
    cleanup();
  }
});

test('.router/models.yaml overrides a slot, other slots keep the default', () => {
  const { paths, cleanup } = freshPaths();
  try {
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      modelsYamlPath(paths),
      ['codex:', '  strong: { model: gpt-9-omega, effort: ultra }'].join('\n'),
    );
    const cfg = loadModelConfig(paths);
    assert.equal(cfg.codex.strong.model, 'gpt-9-omega'); // overridden
    assert.equal(cfg.codex.strong.effort, 'ultra');
    assert.equal(cfg.codex.weak.model, 'gpt-5.6-terra'); // untouched default
    assert.equal(cfg.claude.strong.model, 'opus'); // untouched default
  } finally {
    cleanup();
  }
});

test('the default constant is not mutated by loads', () => {
  const { paths, cleanup } = freshPaths();
  try {
    const cfg = loadModelConfig(paths);
    cfg.codex.weak.model = 'MUTATED';
    assert.equal(DEFAULT_MODEL_CONFIG.codex.weak.model, 'gpt-5.6-terra');
  } finally {
    cleanup();
  }
});

test('tierWorkers yields one candidate per executor carrying its tier model + effort', () => {
  const weak = tierWorkers(DEFAULT_MODEL_CONFIG, 'weak');
  assert.deepEqual(weak, [
    { kind: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' },
    { kind: 'claude', model: 'haiku', effort: 'xhigh' },
  ]);
  const strong = tierWorkers(DEFAULT_MODEL_CONFIG, 'strong');
  assert.equal(strong[0]?.model, 'gpt-5.6-sol');
  assert.equal(strong[0]?.effort, 'max');
  assert.equal(strong[1]?.model, 'opus');
});
