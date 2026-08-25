// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
type Settings = {
  statusLine?: { type?: string; command?: string; refreshInterval?: number; [k: string]: unknown };
  [k: string]: unknown;
};
const readSettings = (p: string): Settings => JSON.parse(readFileSync(p, 'utf8')) as Settings;
const configuredCommand = `node '${SL}'`;

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
    assert.deepEqual(s.statusLine, {
      type: 'command',
      command: configuredCommand,
      refreshInterval: 2,
    });
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
    assert.equal(readSettings(settings).statusLine!.refreshInterval, 2);

    const second = JSON.parse(router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']).out);
    assert.equal(second.action, 'already-configured'); // no double-wrap
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updated: repairs a current command missing refreshInterval and tells the user to restart', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: configuredCommand } }));

    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^updated statusLine/m);
    assert.match(r.out, /restart Claude Code/);
    assert.equal(readSettings(settings).statusLine?.refreshInterval, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updated: corrects a user-supplied refreshInterval to the required value 2', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: 'command', command: configuredCommand, refreshInterval: 10 } }),
    );

    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.out).action, 'updated');
    assert.equal(readSettings(settings).statusLine?.refreshInterval, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('already-configured: leaves content and mtime unchanged when all managed fields match', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: 'command', command: configuredCommand, refreshInterval: 2 } }),
    );
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(settings, oldTime, oldTime);
    const contentBefore = readFileSync(settings, 'utf8');
    const mtimeBefore = statSync(settings).mtimeMs;

    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.out).action, 'already-configured');
    assert.equal(readFileSync(settings, 'utf8'), contentBefore);
    assert.equal(statSync(settings).mtimeMs, mtimeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preserves unknown statusLine keys while updating managed fields', () => {
  const dir = tmp();
  try {
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ statusLine: { type: 'command', command: 'my-hud', padding: 'compact' } }),
    );

    const r = router(['setup-statusline', '--settings', settings, '--statusline', SL, '--json']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.out).action, 'chained');
    const statusLine = readSettings(settings).statusLine;
    assert.equal(statusLine?.padding, 'compact');
    assert.equal(statusLine?.type, 'command');
    assert.equal(statusLine?.refreshInterval, 2);
    assert.match(statusLine?.command ?? '', /ROUTER_INNER_STATUSLINE='my-hud' node/);
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

test('dry-run: missing or nonstandard refreshInterval is reported without touching settings', () => {
  const cases = [
    { name: 'missing', statusLine: { type: 'command', command: configuredCommand } },
    { name: 'nonstandard', statusLine: { type: 'command', command: configuredCommand, refreshInterval: 10 } },
  ];

  for (const c of cases) {
    const dir = tmp();
    try {
      const settings = join(dir, 'settings.json');
      writeFileSync(settings, JSON.stringify({ statusLine: c.statusLine, marker: c.name }));
      const before = readFileSync(settings, 'utf8');

      const r = router([
        'setup-statusline',
        '--settings',
        settings,
        '--statusline',
        SL,
        '--dry-run',
        '--json',
      ]);
      assert.equal(r.code, 0, `${c.name}: ${r.out}`);
      assert.equal(JSON.parse(r.out).action, 'updated');
      assert.equal(readFileSync(settings, 'utf8'), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
