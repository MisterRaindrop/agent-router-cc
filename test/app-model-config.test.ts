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
  const tempRoot = mkdtempSync(join(tmpdir(), 'router-mc-'));
  return {
    paths: routerPaths(join(tempRoot, '.router')),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

test('loadModelConfig falls back to the bundled default when no models.yaml exists', () => {
  const { paths, cleanup } = freshPaths();
  try {
    const cfg = loadModelConfig(paths);
    assert.deepEqual(cfg, DEFAULT_MODEL_CONFIG);
    assert.equal(cfg.codex.weak.model, 'gpt-5.6-terra');
    // Effort is matched to the work: mechanical implementation at medium, a task that
    // needs capability at high. Effort sits on the critical path of a dispatch, and a
    // contract that already states what to do gains little from deeper deduction.
    assert.equal(cfg.codex.weak.effort, 'medium');
    assert.equal(cfg.codex.strong.effort, 'high');
    assert.deepEqual(cfg.codex.critical, { model: 'gpt-5.6-sol', effort: 'xhigh' });
    assert.equal(cfg.claude.strong.model, 'sonnet');
    assert.deepEqual(cfg.claude.critical, { model: 'opus', effort: 'xhigh' });
    assert.equal(cfg.review[0]?.kind, 'codex');
    // Reviewers default to high; xhigh/max is an explicit opt-in escalation for a rare
    // final high-stakes pass, set per repo in `.router/models.yaml`.
    assert.equal(cfg.review[0]?.effort, 'high');
    assert.equal(cfg.review[1]?.effort, 'high');
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
      ['codex:', '  critical: { model: gpt-9-omega, effort: ultra }'].join('\n'),
    );
    const cfg = loadModelConfig(paths);
    assert.equal(cfg.codex.critical.model, 'gpt-9-omega'); // overridden
    assert.equal(cfg.codex.critical.effort, 'ultra');
    assert.equal(cfg.codex.weak.model, 'gpt-5.6-terra'); // untouched default
    assert.equal(cfg.codex.strong.model, 'gpt-5.6-sol'); // untouched default
    assert.equal(cfg.claude.strong.model, 'sonnet'); // untouched default
    assert.equal(cfg.claude.critical.model, 'opus'); // untouched default
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
    { kind: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
    { kind: 'claude', model: 'haiku', effort: 'medium' },
  ]);
  const strong = tierWorkers(DEFAULT_MODEL_CONFIG, 'strong');
  assert.equal(strong[0]?.model, 'gpt-5.6-sol');
  assert.equal(strong[0]?.effort, 'high');
  assert.equal(strong[1]?.model, 'sonnet');
  assert.equal(strong[1]?.effort, 'high');
  const critical = tierWorkers(DEFAULT_MODEL_CONFIG, 'critical');
  assert.deepEqual(critical, [
    { kind: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    { kind: 'claude', model: 'opus', effort: 'xhigh' },
  ]);
});
