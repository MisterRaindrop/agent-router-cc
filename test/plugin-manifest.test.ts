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
  assert.ok(p.author && typeof p.author.name === 'string', 'plugin needs author attribution');
});

test('marketplace.json lists the router plugin so it is installable', () => {
  const m = JSON.parse(read('../.claude-plugin/marketplace.json'));
  assert.ok(typeof m.name === 'string' && m.name.length > 0, 'marketplace needs a name');
  assert.ok(typeof m.description === 'string' && m.description.length > 0, 'marketplace needs a description');
  assert.ok(m.owner && typeof m.owner.name === 'string', 'marketplace needs an owner.name');
  assert.ok(Array.isArray(m.plugins) && m.plugins.length > 0, 'marketplace needs plugins');
  const router = m.plugins.find((p: { name: string }) => p.name === 'router');
  assert.ok(router, 'marketplace must list the router plugin');
  assert.ok(typeof router.source === 'string' && router.source.length > 0, 'router plugin needs a source');
});

test('every command has a description in its frontmatter', () => {
  const dir = new URL('../commands/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'expected at least one command');
  for (const f of files) {
    const fm = frontmatter(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(fm.description, `${f}: missing description`);
    if (fm['argument-hint']) {
      const body = readFileSync(new URL(f, dir), 'utf8');
      assert.doesNotMatch(body, /\$[1-9]\b/, `${f}: Claude commands do not populate shell positional parameters`);
      assert.match(body, /\$ARGUMENTS\b/, `${f}: argument-taking command must use $ARGUMENTS`);
    }
  }
});

test('init keeps router runtime state gitignored and does not mention removed policy flow', () => {
  const body = read('../commands/init.md');
  assert.match(body, /do NOT stage or commit/i);
  assert.doesNotMatch(body, /committed base_sha|default policy|policy works/i);
});

test('every agent declares name + model', () => {
  const dir = new URL('../agents/', import.meta.url);
  if (!existsSync(fileURLToPath(dir))) return; // no plugin agents shipped -> nothing to validate
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const fm = frontmatter(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(fm.name, `${f}: missing name`);
    assert.match(fm.model ?? '', /^(sonnet|haiku|opus|inherit)$/, `${f}: bad model`);
  }
});

test('hooks.json wires the PreToolUse guard and the guard script exists', () => {
  const h = JSON.parse(read('../hooks/hooks.json'));
  assert.ok(h.hooks.PreToolUse);
  assert.match(JSON.stringify(h), /guard-router-state\.mjs/);
  assert.ok(existsSync(fileURLToPath(new URL('../hooks/guard-router-state.mjs', import.meta.url))));
  void root;
});

// --- The command surface after the v2 restructure (acceptance 6.2) ---------------------
//
// Asserted here rather than left to review, because a command file is the whole implementation
// of a command: if `brainstorm.md` is missing, the stage does not exist, and nothing else fails.

const COMMANDS = new URL('../commands/', import.meta.url);
const commandFiles = (): string[] => readdirSync(COMMANDS).filter((f) => f.endsWith('.md'));

test('the six flow commands all exist', () => {
  const present = new Set(commandFiles());
  for (const stage of ['brainstorm', 'design', 'design-review', 'workplan', 'go', 'review']) {
    assert.ok(present.has(`${stage}.md`), `missing /router:${stage}`);
  }
});

// These four existed only to drive parallel orchestration or to be a deprecated predecessor.
// The MECHANISM survives where it is still needed -- `router dispatch` is still the CLI verb go
// uses, and the queue gate's lock and clean-gate selection moved into the dispatch flow -- but
// none of them is a thing the user is asked to choose any more.
test('dispatch, gate, land and spec are no longer slash commands', () => {
  const present = new Set(commandFiles());
  for (const gone of ['dispatch.md', 'gate.md', 'land.md', 'spec.md']) {
    assert.ok(!present.has(gone), `${gone} should have been removed`);
  }
});

test('plan is a stub that names its replacement, and workplan carries the content', () => {
  const stub = readFileSync(new URL('plan.md', COMMANDS), 'utf8');
  assert.match(stub, /\/router:workplan/);
  assert.match(frontmatter(stub).description ?? '', /renamed/i);
  // Short enough that nobody mistakes it for the real thing.
  assert.ok(stub.split('\n').length < 15, 'the alias should be a stub, not a copy');

  const real = readFileSync(new URL('workplan.md', COMMANDS), 'utf8');
  assert.match(real, /WORKPLAN\.md/);
  assert.match(real, /Verification matrix/i);
});

// go.md was 379 lines with a single `##` heading, 64 of them describing concurrent dispatch.
// Both are gone: the concurrency because the feature is, the bulk because contract-authoring
// detail moved to references/ where it can be read when it is needed.
test('go.md carries the flow, not the contract-authoring detail', () => {
  const body = readFileSync(new URL('go.md', COMMANDS), 'utf8');
  assert.doesNotMatch(body, /--max-parallel/);
  assert.doesNotMatch(body, /CONCURRENTLY/);
  assert.doesNotMatch(body, /run independent packages/i);
  // The detail it used to inline now lives one reference away.
  assert.match(body, /references\/task-contract\.md/);
  assert.doesNotMatch(body, /allowed_globs`: the smallest scope/);
  assert.ok(body.split('\n').length < 280, `go.md is ${body.split('\n').length} lines`);
});

// The three-way contradiction the design review found: go.md said TASK_CONTEXT.md is not
// written, go.md also said to write it, and work-package.md said by default. One answer now.
test('TASK_CONTEXT.md has one answer across the whole repository', () => {
  const files = [
    readFileSync(new URL('go.md', COMMANDS), 'utf8'),
    readFileSync(new URL('../references/task-contract.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../references/work-package.md', import.meta.url), 'utf8'),
  ];
  for (const body of files) {
    for (const line of body.split('\n')) {
      if (!line.includes('TASK_CONTEXT')) continue;
      assert.doesNotMatch(line, /written \*\*by default\*\*|Also write `TASK_CONTEXT/, line);
    }
  }
  const combined = files.join('\n');
  assert.match(combined, /`TASK_CONTEXT\.md` is \*\*not\*\* written|`TASK_CONTEXT\.md` is not written/);
});

test('design-review asks its reviewer what it could not follow', () => {
  const body = readFileSync(new URL('design-review.md', COMMANDS), 'utf8');
  assert.match(body, /Where I could not follow this document/);
  assert.match(body, /curse of knowledge/);
});

// Acceptance 6.4: the four mechanisms plus the decomposition judgement. Each is a rule the
// stage stops being useful without, so each is pinned.
test('brainstorm declares its four mechanisms and the decomposition judgement', () => {
  const body = readFileSync(new URL('brainstorm.md', COMMANDS), 'utf8');
  assert.match(body, /strongest reason this is not worth building/);
  assert.match(body, /Killing an idea with a documented reason is a successful\noutcome/);
  assert.match(body, /at least one alternative they did not raise/);
  assert.match(body, /Compare against how others solve it/);
  assert.match(body, /one feature or several/);
  assert.match(body, /BRAINSTORM\.md/);
  // And it must NOT quietly become a design document.
  assert.match(body, /Do not do design's job here/);
});
