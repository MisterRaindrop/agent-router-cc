// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, hashRoots, loadIndex, refreshIndex } from '../src/io/symbolCache.ts';

const CPP = `namespace N {
class Foo {
public:
  void bar();
  int baz(int x);
};
void Foo::bar() {}
}
`;

function fixture(): { repo: string; src: string; cache: string; file: string } {
  const repo = mkdtempSync(join(tmpdir(), 'router-symidx-'));
  const src = join(repo, 'src');
  mkdirSync(src, { recursive: true });
  const file = join(src, 'foo.cpp');
  writeFileSync(file, CPP);
  return { repo, src, cache: join(repo, 'cache.json'), file };
}

const LIMITS = { maxFiles: 1000, maxBytes: 10_000_000 };

test('buildIndex: extracts class + method decls + fn definition, repo-relative paths', async () => {
  const fx = fixture();
  try {
    const r = await buildIndex([fx.src], fx.cache, fx.repo, LIMITS);
    assert.equal(r.degraded, undefined);
    assert.equal(r.files, 1);
    assert.equal(r.reparsed, 1);
    const idx = loadIndex(fx.cache)!;
    assert.equal(idx.files[0]!.file, 'src/foo.cpp'); // repo-relative, not absolute
    const names = idx.files[0]!.symbols.map((s) => `${s.kind} ${s.name}`);
    assert.ok(names.includes('class Foo'));
    assert.ok(names.includes('fn Foo::bar'));
    assert.ok(names.some((n) => n.endsWith('bar') || n.endsWith('baz'))); // decls captured
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
  }
});

test('buildIndex: second build with no change reuses cache (reparsed 0)', async () => {
  const fx = fixture();
  try {
    await buildIndex([fx.src], fx.cache, fx.repo, LIMITS);
    const again = await buildIndex([fx.src], fx.cache, fx.repo, LIMITS);
    assert.equal(again.reparsed, 0); // mtime unchanged -> reused
    assert.ok(again.symbols > 0);
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
  }
});

test('refreshIndex: a changed file is re-parsed and new symbols appear', async () => {
  const fx = fixture();
  try {
    await buildIndex([fx.src], fx.cache, fx.repo, LIMITS);
    // Rewrite with an added class; bump mtime explicitly (fast machines can share it).
    const later = new Date(Date.now() + 4000);
    writeFileSync(fx.file, CPP + '\nclass Added {};\n');
    const { utimesSync } = await import('node:fs');
    utimesSync(fx.file, later, later);
    const r = await refreshIndex(fx.cache, fx.repo);
    assert.notEqual(r, null);
    assert.equal(r!.reparsed, 1);
    const names = r!.index.files.flatMap((f) => f.symbols.map((s) => s.name));
    assert.ok(names.includes('Added'));
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
  }
});

test('buildIndex: over maxFiles degrades loud, does not index', async () => {
  const fx = fixture();
  try {
    const r = await buildIndex([fx.src], fx.cache, fx.repo, { maxFiles: 0, maxBytes: 10_000_000 });
    assert.notEqual(r.degraded, undefined);
    assert.match(r.degraded!.reason, /too large/);
  } finally {
    rmSync(fx.repo, { recursive: true, force: true });
  }
});

test('hashRoots: order-independent, stable', () => {
  assert.equal(hashRoots(['/a', '/b']), hashRoots(['/b', '/a']));
  assert.notEqual(hashRoots(['/a']), hashRoots(['/a', '/b']));
});
