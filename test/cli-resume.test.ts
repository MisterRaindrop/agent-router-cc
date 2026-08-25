// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as fx from '../testkit/gitRepo.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../testkit/fakeCodex.mjs', import.meta.url));
const FAKE_CODEX_MISMATCH = fileURLToPath(new URL('../testkit/fakeCodexResumeMismatch.mjs', import.meta.url));
const FAKE_DELIVERY = fileURLToPath(new URL('./fixtures/fakeCodexDelivery.mjs', import.meta.url));
const NODE = process.execPath;

function router(dir: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}): { code: number; out: string } {
  try {
    const out = execFileSync(NODE, [ENTRY, ...argv], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...envExtra } });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}
const jsonLine = (out: string): Record<string, unknown> =>
  JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}');

const baseEnv = (dir: string) => ({ ROUTER_CODEX_BIN: FAKE_CODEX, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') });

test('dispatch then resume: re-attaches to the same session and commits the follow-up', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    const d = jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out);
    assert.equal(d.verifier, 'PASSED', JSON.stringify(d));

    const r = router(dir, ['resume', 'demo', '--feedback', 'tighten it', '--json'], env);
    const rj = jsonLine(r.out);
    assert.equal(rj.resumed, true, r.out);
    assert.equal(rj.session_mismatch, false, r.out);
    assert.equal(rj.verifier, 'PASSED', r.out);
    assert.equal(r.code, 0, r.out);
  } finally {
    fx.cleanup(dir);
  }
});

// Review finding 11. This test was named "commits nothing" and never looked at HEAD, while the
// fake it drives commits on both runs -- so the real behaviour was "the branch moved and nothing
// verified it", and the CLI told the user `nothing committed`. The test's own title was the claim
// it failed to check, and it kept a false message green.
test('resume is fail-loud: a mismatched session id verifies nothing, and says so truthfully', () => {
  chmodSync(FAKE_CODEX_MISMATCH, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_CODEX_MISMATCH, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    router(dir, ['dispatch', 'demo', '--json'], env);

    const r = router(dir, ['resume', 'demo', '--feedback', 'x', '--json'], env);
    const rj = jsonLine(r.out);
    assert.equal(rj.session_mismatch, true, r.out);
    assert.equal(rj.ok, false, r.out);
    assert.equal(r.code, 1, r.out);
    // Nothing was VERIFIED -- that is the actual guarantee.
    assert.equal(rj.verifier, null, r.out);

    // And the branch DID move, which is why the old message was a lie. Assert the state rather
    // than the wording alone, since the wording is what was wrong.
    const head = fx.git(dir, ['rev-parse', 'HEAD']).trim();
    const base = fx.git(dir, ['rev-parse', 'HEAD~1']).trim();
    assert.notEqual(head, base);
    assert.match(fx.git(dir, ['log', '-1', '--pretty=%s']).trim(), /fake/);

    // The human-readable line must not claim otherwise.
    const text = router(dir, ['resume', 'demo', '--feedback', 'x'], env);
    assert.doesNotMatch(text.out, /nothing committed/);
    assert.match(text.out, /NOT verified/);
    assert.match(text.out, /has cleared no gate/);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume replaces DELIVERY.md with the resumed executor final message', () => {
  chmodSync(FAKE_DELIVERY, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = { ROUTER_CODEX_BIN: FAKE_DELIVERY, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'delivery-valid'], env);
    assert.equal(router(dir, ['dispatch', 'delivery-valid', '--json'], env).code, 0);
    const delivery = join(dir, '.router', 'tasks', 'delivery-valid', 'DELIVERY.md');
    assert.match(readFileSync(delivery, 'utf8'), /^Delivery report/);

    const resumed = router(dir, ['resume', 'delivery-valid', '--feedback', 'finish', '--json'], env);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(readFileSync(delivery, 'utf8'), /^Resumed delivery/);
    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'delivery-valid', 'result.json'), 'utf8'),
    ) as { delivery: { header: { task: string }; header_error?: string } };
    assert.equal(result.delivery.header.task, 'delivery-valid');
    assert.equal(result.delivery.header_error, undefined);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume without a prior dispatch errors clearly', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo']);
    const r = router(dir, ['resume', 'demo', '--feedback', 'x']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /no prior dispatch|resume/i);
  } finally {
    fx.cleanup(dir);
  }
});

test('resume requires --feedback', () => {
  const dir = fx.initRepo();
  fx.addCommit(dir, 'base');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo']);
    const r = router(dir, ['resume', 'demo']);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /feedback/i);
  } finally {
    fx.cleanup(dir);
  }
});

// Measured: `codex exec resume` rejects flags that `codex exec` accepts, and such a run dies
// before the session starts, reporting no session id at all. The old guard read that absence
// as agreement and committed the work; it must fail loud instead.
test('a resume that reports no session id is not treated as re-attached', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const bin = fileURLToPath(new URL('../testkit/fakeCodexResumeSilent.mjs', import.meta.url));
  chmodSync(bin, 0o755);
  const env = { ROUTER_CODEX_BIN: bin, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'no-sessions') };
  try {
    router(dir, ['new', 'silent'], env);
    assert.equal(router(dir, ['dispatch', 'silent', '--json'], env).code, 0);
    const r = router(dir, ['resume', 'silent', '--feedback', 'try again', '--json'], env);
    assert.equal(r.code, 1, r.out);
    const out = JSON.parse(r.out.split('\n').find((line) => line.trim().startsWith('{')) ?? '{}') as Record<string, unknown>;
    assert.equal(out.session_mismatch, true);
    // Nothing may be committed under a continuity claim nothing supports.
    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'silent', 'result.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(result.resume_session_mismatch, true);
    assert.equal(result.resume_reported_session, null);
    assert.equal(result.verifier, undefined);
  } finally {
    fx.cleanup(dir);
  }
});

// Resume's precondition changed with the execution model. It used to be "the worktree directory
// still exists"; the work lives in git now, so it is "the branch still exists, and we are on it".
// Both halves are refusals rather than silent corrections: a cold restart dressed up as a resume
// throws away the context that made resuming worth doing, and resuming on the wrong branch
// verifies a diff that has nothing to do with the task.
test('resume refuses when the task branch is gone rather than restarting cold', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(router(dir, ['dispatch', 'demo', '--json'], env).code, 0);

    fx.git(dir, ['checkout', '-q', 'main']);
    fx.git(dir, ['branch', '-D', 'router/demo']);
    const r = router(dir, ['resume', 'demo', '--feedback', 'try again'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /branch router\/demo for demo is gone; resume unavailable/);
    assert.match(r.out, /re-dispatch instead/);
  } finally {
    fx.cleanup(dir);
  }
});

// Fault-injection case 8e.
test('resume refuses from the wrong branch instead of continuing there (8e)', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(router(dir, ['dispatch', 'demo', '--json'], env).code, 0);

    // The user wandered off mid-task -- impossible to notice under the worktree model, ordinary
    // here, and destructive if resume just carried on.
    fx.git(dir, ['checkout', '-q', 'main']);
    const r = router(dir, ['resume', 'demo', '--feedback', 'try again'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /on branch main, but task requires router\/demo/);
    // Nothing ran: no new commit on either branch.
    assert.equal(fx.git(dir, ['branch', '--show-current']).trim(), 'main');
  } finally {
    fx.cleanup(dir);
  }
});

// Review finding 6. Resume ran an executor in the user's own checkout with no transaction at
// all: no lock, no heartbeat, no published process group, no identity assertion before
// verification, and without reading gate.yaml. The reviewer measured the sharpest consequence --
// a deliberately failing project gate FAILED a fresh dispatch while a resume on the same fixture
// reported PASSED, because resume verified with `task.verify` and never saw the gate.
test('resume honours the project gate instead of bypassing it (finding 6)', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.write(dir, '.gitignore', '.router/\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    // A gate that passes, so the first dispatch can succeed and produce a session to resume.
    writeFileSync(
      join(dir, '.router', 'gate.yaml'),
      `mode: worktree\ngate:\n  - ${JSON.stringify([NODE, '-e', 'process.exit(0)'])}\n`,
    );
    assert.equal(router(dir, ['dispatch', 'demo', '--json'], env).code, 0);

    // Now the gate fails. A resume must see that.
    writeFileSync(
      join(dir, '.router', 'gate.yaml'),
      `mode: worktree\ngate:\n  - ${JSON.stringify([NODE, '-e', 'process.exit(4)'])}\n`,
    );
    const r = router(dir, ['resume', 'demo', '--feedback', 'another pass', '--json'], env);
    const out = jsonLine(r.out);
    assert.equal(out.verifier, 'FAILED', `resume bypassed the gate: ${r.out}`);
    assert.notEqual(r.code, 0);

    const result = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'demo', 'result.json'), 'utf8'),
    ) as { verifier: { checks: { id: string; ok: boolean }[] } };
    const ids = result.verifier.checks.map((c) => c.id);
    assert.ok(ids.includes('gate:task'), `resume ran no project gate: ${ids.join(',')}`);
  } finally {
    fx.cleanup(dir);
  }
});

// The other half: resume must hold the checkout lock, or it can run beside a dispatch.
test('resume refuses while another process holds the checkout (finding 6)', () => {
  chmodSync(FAKE_CODEX, 0o755);
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const env = baseEnv(dir);
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(router(dir, ['dispatch', 'demo', '--json'], env).code, 0);

    // A live holder: our own pid, beating now, so it is neither dead nor stale.
    writeFileSync(
      join(dir, '.router', 'gate.lock'),
      `${JSON.stringify({ pid: process.pid, startedAtMs: Date.now(), beatAtMs: Date.now(), ownerToken: 'someone-else' })}\n`,
    );
    const r = router(dir, ['resume', 'demo', '--feedback', 'try again'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /the checkout is held by pid/);
    assert.match(r.out, /router runs one task at a time/);
  } finally {
    fx.cleanup(dir);
  }
});

// The follow-up review's `regressed` verdict, reproduced end to end.
//
// Making the closeout check fail CLOSED (throw on a broken index instead of answering "clean")
// was only half a fix. On the resume path the throw escaped before anything was written, so the
// attempt left NO record -- while the resumed executor's commit sat on the task branch and the
// PREVIOUS run's PASSED result.json still pointed at that branch. Repair the repo, run
// `router land`, and unverified code goes into main: measured as
// `{"resumeCode":1,"storedVerifier":"PASSED","landCode":0}`. Against the pre-fix code this test
// finds `attempt_number: 1, exit_class: "ok", verifier: PASSED` -- the failed resume simply is
// not there.
//
// Two independent things have to hold now: the failed attempt is persisted, and `land` refuses a
// branch whose tip has moved past the commit that was actually verified.
test('a resume that cannot finish its closeout records the failure and cannot be landed', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  // Commits its unit and then leaves the index unreadable -- a crash mid-write, a concurrent git
  // process, a full disk. The closeout check has to fail CLOSED on that; what this test is about
  // is what happens after it does.
  const wrecker = join(dir, 'fake-wrecker.mjs');
  writeFileSync(
    wrecker,
    '#!/usr/bin/env node\n' +
      "import { execFileSync } from 'node:child_process';\n" +
      "import { writeFileSync } from 'node:fs';\n" +
      "const resumed = process.argv.includes('resume');\n" +
      "writeFileSync('src/a.ts', `export const x = ${resumed ? 3 : 2};\\n`);\n" +
      'execFileSync("git", ["add", "--", "src/a.ts"]);\n' +
      'execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@l", "commit", "-q", "-m", "fake: unit a"]);\n' +
      "if (resumed) writeFileSync('.git/index', 'not an index at all');\n" +
      'process.stdout.write(JSON.stringify({type:"thread.started",model:"fake-model-1",thread_id:"fake-session-demo"})+"\\n");\n' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(wrecker, 0o755);
  const env = { ROUTER_CODEX_BIN: wrecker, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  const resultPath = join(dir, '.router', 'tasks', 'demo', 'result.json');
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    const d = jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out);
    assert.equal(d.verifier, 'PASSED', JSON.stringify(d));
    const passed = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      attempt_number: number;
      verified_head?: string;
      branch: string;
    };
    assert.match(passed.verified_head ?? '', /^[0-9a-f]{40}$/, 'the verdict names no commit');

    const r = router(dir, ['resume', 'demo', '--feedback', 'tighten it', '--json'], env);
    assert.notEqual(r.code, 0, r.out);
    // The user repairs their repo and carries on -- which is when the hazard bites.
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, stdio: 'ignore' });

    // 1. The failed attempt is on record, with the closeout failure that caused it.
    const stored = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      attempt_number: number;
      exit_class: string;
      verifier: { result: string } | undefined;
      closeout?: { ok: boolean; reason: string };
    };
    assert.equal(stored.attempt_number, passed.attempt_number + 1, JSON.stringify(stored));
    assert.equal(stored.exit_class, 'task_failed', JSON.stringify(stored));
    assert.equal(stored.verifier, undefined, 'a failed resume left a verifier verdict behind');
    assert.equal(stored.closeout?.ok, false, JSON.stringify(stored));

    // 2. And the branch cannot be landed on the old verdict either way, because the resumed
    //    executor committed: the tip has moved past the commit that actually PASSED.
    const tip = fx.git(dir, ['rev-parse', passed.branch]).trim();
    assert.notEqual(tip, passed.verified_head, 'the fixture never moved the branch');
    fx.git(dir, ['checkout', '-q', 'main']);
    const l = router(dir, ['land', 'demo', '--json'], env);
    assert.notEqual(l.code, 0, `land merged unverified work: ${l.out}`);
    assert.match(l.out, /unverified|was verified|not PASSED/i, l.out);
    // Nothing the executor committed reached main -- not the resumed commit, and not the first
    // dispatch's either, since that branch was never landed. (main legitimately carries the
    // rescue commit for the user's own untracked files, made before the branch was cut.)
    assert.doesNotMatch(fx.git(dir, ['log', '--format=%s', 'main']), /fake: unit a/, 'main moved');
    assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'export const x = 1;\n');
  } finally {
    fx.cleanup(dir);
  }
});

// `router-state-write-escape`, still partial after round 1: a fresh dispatch detected a forged
// `.router/` write and failed, while the IDENTICAL write through a resume reported PASSED --
// because resume never fingerprinted the state at all.
test('a resume that forges router state fails the run, exactly as a fresh dispatch does', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const forger = join(dir, 'fake-forger.mjs');
  writeFileSync(
    forger,
    '#!/usr/bin/env node\n' +
      "import { execFileSync } from 'node:child_process';\n" +
      "import { mkdirSync, writeFileSync } from 'node:fs';\n" +
      "const resumed = process.argv.includes('resume');\n" +
      "writeFileSync('src/a.ts', `export const x = ${resumed ? 3 : 2};\\n`);\n" +
      'execFileSync("git", ["add", "--", "src/a.ts"]);\n' +
      'execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@l", "commit", "-q", "-m", "fake: unit a"]);\n' +
      // The forgery, on the RESUME turn only, so the first dispatch is a clean PASSED.
      'if (resumed) {\n' +
      '  mkdirSync(".router/tasks/forged", { recursive: true });\n' +
      '  writeFileSync(".router/tasks/forged/result.json", JSON.stringify({task_id:"forged",exit_class:"ok",verifier:{result:"PASSED",checks:[]}}));\n' +
      '}\n' +
      'process.stdout.write(JSON.stringify({type:"thread.started",model:"fake-model-1",thread_id:"fake-session-demo"})+"\\n");\n' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(forger, 0o755);
  const env = { ROUTER_CODEX_BIN: forger, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out).verifier, 'PASSED');

    const r = router(dir, ['resume', 'demo', '--feedback', 'again', '--json'], env);
    assert.equal(jsonLine(r.out).verifier, null, `a forged resume was verified: ${r.out}`);
    assert.notEqual(r.code, 0, r.out);
    const stored = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'demo', 'result.json'), 'utf8'),
    ) as { exit_class: string; state_tampering?: string[] };
    assert.equal(stored.exit_class, 'task_failed', JSON.stringify(stored));
    assert.ok(
      stored.state_tampering?.some((line) => line.includes('tasks/forged/result.json')),
      JSON.stringify(stored.state_tampering),
    );
  } finally {
    fx.cleanup(dir);
  }
});

// Separating "may we verify?" from "what actually happened". The first version of the resume
// transaction collapsed both into one flag, so a resume that ran out of quota, timed out, stalled
// or crashed was all stored as a flat `task_failed` -- the diagnosis, the retry semantics and the
// usage rollup all reading the wrong cause. Only a broken CONTRACT should override the taxonomy.
test('a resume that hits the provider quota is recorded as quota_exhausted, not just failed', () => {
  const dir = fx.initRepo();
  fx.write(dir, 'src/a.ts', 'export const x = 1;\n');
  fx.addCommit(dir, 'base');
  const quota = join(dir, 'fake-quota.mjs');
  writeFileSync(
    quota,
    '#!/usr/bin/env node\n' +
      "import { execFileSync } from 'node:child_process';\n" +
      "import { writeFileSync } from 'node:fs';\n" +
      "const resumed = process.argv.includes('resume');\n" +
      'if (resumed) {\n' +
      // Re-attaches (same session id), then dies on the provider's rate limit.
      '  process.stdout.write(JSON.stringify({type:"thread.started",model:"fake-model-1",thread_id:"fake-session-demo"})+"\\n");\n' +
      '  process.stdout.write(JSON.stringify({type:"error",message:"429 usage limit reached for this account"})+"\\n");\n' +
      '  process.exit(1);\n' +
      '}\n' +
      "writeFileSync('src/a.ts', 'export const x = 2;\\n');\n" +
      'execFileSync("git", ["add", "--", "src/a.ts"]);\n' +
      'execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@l", "commit", "-q", "-m", "fake: unit a"]);\n' +
      'process.stdout.write(JSON.stringify({type:"thread.started",model:"fake-model-1",thread_id:"fake-session-demo"})+"\\n");\n' +
      'process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})+"\\n");\n',
  );
  chmodSync(quota, 0o755);
  const env = { ROUTER_CODEX_BIN: quota, ROUTER_CODEX_SESSIONS_DIR: join(dir, 'none') };
  try {
    router(dir, ['new', 'demo', '--title', 'Demo'], env);
    assert.equal(jsonLine(router(dir, ['dispatch', 'demo', '--json'], env).out).verifier, 'PASSED');

    const r = router(dir, ['resume', 'demo', '--feedback', 'again', '--json'], env);
    assert.notEqual(r.code, 0, r.out);
    const stored = JSON.parse(
      readFileSync(join(dir, '.router', 'tasks', 'demo', 'result.json'), 'utf8'),
    ) as { exit_class: string; attempt_number: number; verifier?: unknown; resume_session_mismatch?: boolean };
    assert.equal(stored.attempt_number, 2, JSON.stringify(stored));
    assert.equal(stored.resume_session_mismatch, undefined, 'the session DID re-attach');
    assert.equal(
      stored.exit_class,
      'quota_exhausted',
      `the real cause was flattened away: ${JSON.stringify(stored)}`,
    );
    // Still not verified -- separating the taxonomy must not loosen the gate.
    assert.equal(stored.verifier, undefined);
  } finally {
    fx.cleanup(dir);
  }
});
