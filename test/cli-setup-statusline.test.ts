// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const SL = fileURLToPath(new URL('../statusline/router-usage.mjs', import.meta.url));
const NODE = process.execPath;

function router(argv: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(NODE, [ENTRY, ...argv], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}
const tmp = (): string => mkdtempSync(join(tmpdir(), 'router-sl-'));
type Settings = { statusLine?: { type?: string; command?: string }; [k: string]: unknown };
const readSettings = (p: string): Settings => JSON.parse(readFileSync(p, 'utf8')) as Settings;

test('created: writes a statusLine into a fresh settings.json, preserving other keys', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ theme: 'dark' }));
    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.out);
    assert.equal(j.action, 'created');
    assert.equal(j.statusline_exists, true);
    const s = readSettings(settings);
    assert.equal(s.theme, 'dark'); // untouched
    assert.equal(s.statusLine?.command, `node '${SL}'`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chained: an existing statusline is preserved, and re-running is idempotent', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-hud' } }));

    const first = JSON.parse(router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']).out);
    assert.equal(first.action, 'chained');
    assert.equal(first.chained, 'my-hud');
    assert.match(readSettings(settings).statusLine!.command!, /ROUTER_INNER_STATUSLINE='my-hud' node/);

    const second = JSON.parse(router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']).out);
    assert.equal(second.action, 'already-configured'); // no double-wrap
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run: reports the plan without writing the file', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json'); // does not exist
    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL, '--dry-run', '--json']);
    const j = JSON.parse(r.out);
    assert.equal(j.action, 'created');
    assert.equal(j.dry_run, true);
    assert.equal(existsSync(settings), false); // nothing written
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing wrapper path is reported (statusline_exists=false)', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    const r = router(['setup-statusline', '--settings', settings, '--statusline', join(dir, 'nope.mjs'), '--json']);
    assert.equal(JSON.parse(r.out).statusline_exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
