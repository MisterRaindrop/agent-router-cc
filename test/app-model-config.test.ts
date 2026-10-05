// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPaths } from '../src/io/paths.ts';
import { DEFAULT_MODEL_CONFIG, loadModelConfig } from '../src/app/modelConfig.ts';

function freshPaths() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'router-mc-'));
  const root = join(tempRoot, '.router');
  mkdirSync(root, { recursive: true });
  return {
    root,
    paths: routerPaths(root),
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

test('loadModelConfig falls back to the bundled default when no models.yaml exists', () => {
  const { paths, cleanup } = freshPaths();
  try {
    const cfg = loadModelConfig(paths);
    assert.deepEqual(cfg, DEFAULT_MODEL_CONFIG);
    // The writer pin always carries an effort: an omitted one silently falls back to the
    // provider default.
    assert.equal(cfg.writer.model, 'gpt-5.6-sol');
    assert.equal(cfg.writer.effort, 'xhigh');
    assert.equal(cfg.review[0]!.kind, 'codex', 'the first reviewer is independent of the main session');
  } finally {
    cleanup();
  }
});

test('a `writer:` in models.yaml replaces the writer and keeps the reviewer chain', () => {
  const { paths, root, cleanup } = freshPaths();
  try {
    writeFileSync(join(root, 'models.yaml'), 'writer: { model: gpt-5.7, effort: high }\n');
    const cfg = loadModelConfig(paths);
    assert.deepEqual(cfg.writer, { model: 'gpt-5.7', effort: 'high' });
    assert.deepEqual(cfg.review, DEFAULT_MODEL_CONFIG.review);
  } finally {
    cleanup();
  }
});

// A models.yaml written for the tiered config must not silently stop choosing the writer: dispatch
// pinned the codex `critical` row, so that row is what the writer was.
test('a tiered models.yaml with no `writer:` still sets the writer from codex.critical', () => {
  const { paths, root, cleanup } = freshPaths();
  try {
    writeFileSync(
      join(root, 'models.yaml'),
      'codex:\n  weak: { model: cheap }\n  critical: { model: gpt-5.6-sol, effort: max }\n',
    );
    assert.deepEqual(loadModelConfig(paths).writer, { model: 'gpt-5.6-sol', effort: 'max' });
  } finally {
    cleanup();
  }
});

test('the default constant is not mutated by loads', () => {
  const { paths, cleanup } = freshPaths();
  try {
    const before = JSON.stringify(DEFAULT_MODEL_CONFIG);
    loadModelConfig(paths).writer.model = 'mutated';
    assert.equal(JSON.stringify(DEFAULT_MODEL_CONFIG), before);
  } finally {
    cleanup();
  }
});
