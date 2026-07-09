// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  assert.ok(m, 'file must start with YAML frontmatter');
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

test('plugin.json is valid and names the plugin', () => {
  const p = JSON.parse(read('../.claude-plugin/plugin.json'));
  assert.equal(p.name, 'router');
  assert.ok(typeof p.description === 'string' && p.description.length > 0);
});

test('every command has a description in its frontmatter', () => {
  const dir = new URL('../commands/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'expected at least one command');
  for (const f of files) {
    const fm = frontmatter(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(fm.description, `${f}: missing description`);
  }
});

test('every agent declares name + model', () => {
  const dir = new URL('../agents/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const fm = frontmatter(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(fm.name, `${f}: missing name`);
    assert.match(fm.model ?? '', /^(sonnet|haiku|opus|inherit)$/, `${f}: bad model`);
  }
});

test('hooks.json wires SessionStart+PreToolUse and the guard script exists', () => {
  const h = JSON.parse(read('../hooks/hooks.json'));
  assert.ok(h.hooks.SessionStart && h.hooks.PreToolUse);
  const cmds = JSON.stringify(h);
  assert.match(cmds, /router\.js/); // SessionStart calls the CLI
  assert.match(cmds, /guard-router-state\.mjs/);
  assert.ok(existsSync(fileURLToPath(new URL('../hooks/guard-router-state.mjs', import.meta.url))));
  void root;
});
