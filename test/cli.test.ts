import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';
import { runCli } from '../src/cli/main.ts';
import { routerPaths } from '../src/io/paths.ts';

// Capture stdout while running a verb in-process.
async function cli(cwd: string, argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    const code = await runCli(argv, cwd);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = orig;
  }
}

function repoWithPolicy(): string {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  const NODE = process.execPath;
  fx.write(
    dir,
    '.router/policy.yaml',
    `schema_version: 1\nmax_concurrent_workers: 1\nworker:\n  kind: codex\n  api_key_env: OPENAI_API_KEY\nscope:\n  test_globs: ["tests/**"]\n  max_changed_lines: 400\nverification:\n  build:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n  test:\n    - [${JSON.stringify(NODE)}, "-e", "process.exit(0)"]\n`,
  );
  fx.addCommit(dir, 'base');
  return dir;
}

test('init scaffolds .router and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-cli-'));
  try {
    const r1 = await cli(dir, ['init', '--json']);
    assert.equal(r1.code, 0);
    const p = routerPaths(join(dir, '.router'));
    assert.ok(JSON.parse(r1.out).ok);
    // idempotent: second init keeps the existing policy
    writeFileSync(p.policy, 'schema_version: 1\ncustom: true\n');
    await cli(dir, ['init']);
    assert.match(readFileSync(p.policy, 'utf8'), /custom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verbs on a dir with no .router exit 3', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-cli-'));
  try {
    const r = await cli(dir, ['list']);
    assert.equal(r.code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lifecycle new -> validate (freeze) -> queue via CLI', async () => {
  const dir = repoWithPolicy();
  try {
    assert.equal((await cli(dir, ['new', 't1', '--title', 'Demo'])).code, 0);
    const v = await cli(dir, ['validate', 't1', '--json']);
    assert.equal(v.code, 0);
    const parsed = JSON.parse(v.out);
    assert.match(parsed.base_sha, /^[0-9a-f]{40}$/);
    assert.match(parsed.contract_hash, /^[0-9a-f]{64}$/);
    // validate is idempotent when unchanged
    const v2 = await cli(dir, ['validate', 't1', '--json']);
    assert.equal(JSON.parse(v2.out).idempotent, true);
    assert.equal((await cli(dir, ['queue', 't1'])).code, 0);
    const s = await cli(dir, ['status', 't1', '--json']);
    assert.equal(JSON.parse(s.out).state, 'QUEUED');
  } finally {
    fx.cleanup(dir);
  }
});

test('validate rejects a task.yaml referencing an unknown verification ref', async () => {
  const dir = repoWithPolicy();
  try {
    await cli(dir, ['new', 't1']);
    const p = routerPaths(join(dir, '.router'));
    const y = readFileSync(p.taskYaml('t1'), 'utf8').replace('build_ref: build', 'build_ref: nope');
    writeFileSync(p.taskYaml('t1'), y);
    const r = await cli(dir, ['validate', 't1']);
    assert.equal(r.code, 1);
  } finally {
    fx.cleanup(dir);
  }
});

test('list --json and stats --json render', async () => {
  const dir = repoWithPolicy();
  try {
    await cli(dir, ['new', 't1']);
    const l = await cli(dir, ['list', '--json']);
    assert.equal(JSON.parse(l.out).tasks[0].id, 't1');
    const s = await cli(dir, ['stats', '--json']);
    assert.equal(JSON.parse(s.out).totalRuns, 0);
  } finally {
    fx.cleanup(dir);
  }
});

test('list --state filters (regression #10: --state was ignored)', async () => {
  const dir = repoWithPolicy();
  try {
    await cli(dir, ['new', 'draft-task']);
    await cli(dir, ['new', 'queued-task']);
    await cli(dir, ['validate', 'queued-task']);
    await cli(dir, ['queue', 'queued-task']);
    const l = await cli(dir, ['list', '--state', 'QUEUED', '--json']);
    const ids = JSON.parse(l.out).tasks.map((t: { id: string }) => t.id);
    assert.deepEqual(ids, ['queued-task']);
  } finally {
    fx.cleanup(dir);
  }
});

test('cancel moves a task to CANCELLED', async () => {
  const dir = repoWithPolicy();
  try {
    await cli(dir, ['new', 't1']);
    await cli(dir, ['cancel', 't1']);
    const s = await cli(dir, ['status', 't1', '--json']);
    assert.equal(JSON.parse(s.out).state, 'CANCELLED');
  } finally {
    fx.cleanup(dir);
  }
});
