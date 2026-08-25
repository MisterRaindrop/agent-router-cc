import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pinnedHead } from './src/app/verifiedHead.ts';
import { acquireLock } from './src/io/lock.ts';

const workspace = process.cwd();
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (cwd, rel, text) => {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const commit = (cwd, message) => {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message, '--allow-empty']);
  return git(cwd, ['rev-parse', 'HEAD']);
};
const init = () => {
  const repo = mkdtempSync(join(tmpdir(), 'router-review-repro-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'review']);
  git(repo, ['config', 'user.email', 'review@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
};

function legacyPinCases() {
  const repo = init();
  try {
    write(repo, 'src/a.txt', 'base\n');
    const base = commit(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'router/demo']);
    write(repo, 'src/a.txt', 'verified\n');
    commit(repo, 'verified change');
    const patch = git(repo, ['diff', '--binary', base, 'router/demo']) + '\n';
    const diffSha = createHash('sha256').update(patch).digest('hex');
    const result = {
      task_id: 'demo',
      attempt_number: 1,
      exit_class: 'ok',
      rc: 0,
      timed_out: false,
      stalled: false,
      env_error: false,
      started_at: new Date(0).toISOString(),
      ended_at: new Date(1).toISOString(),
      wall_seconds: 0,
      worker: { kind: 'codex' },
      base_sha: base,
      diff_sha: diffSha,
      verifier: { result: 'PASSED', checks: [] },
    };

    write(repo, 'secret.txt', 'SHOULD_NOT_ENTER_HISTORY\n');
    const secretCommit = commit(repo, 'add secret after verification');
    git(repo, ['rm', '-q', 'secret.txt']);
    commit(repo, 'revert secret before landing');
    const accepted = pinnedHead(repo, 'router/demo', result);
    git(repo, ['checkout', '-q', 'main']);
    if (accepted.ok) {
      git(repo, ['merge', '--no-ff', '--no-edit', '-m', 'land', accepted.sha]);
    }
    const secretReachable = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', secretCommit, 'main'],
      { cwd: repo },
    ).status === 0;

    git(repo, ['checkout', '-q', '-b', 'router/config', base]);
    write(repo, 'src/a.txt', 'config case\n');
    commit(repo, 'same legitimate task');
    git(repo, ['config', '--unset-all', 'diff.noprefix']);
    const normalPatch = git(repo, ['diff', '--binary', base, 'router/config']) + '\n';
    const configResult = { ...result, diff_sha: createHash('sha256').update(normalPatch).digest('hex') };
    git(repo, ['config', 'diff.noprefix', 'true']);
    const refusedAfterConfigChange = pinnedHead(repo, 'router/config', configResult);
    return { accepted, secretReachable, refusedAfterConfigChange };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function stagingCollision() {
  const dir = mkdtempSync(join(tmpdir(), 'router-lock-collision-'));
  const lockPath = join(dir, 'gate.lock');
  const mutexPath = `${lockPath}.reclaim`;
  try {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAtMs: 0, beatAtMs: 0, ownerToken: 'old' })}\n`,
    );
    writeFileSync(
      mutexPath,
      `${JSON.stringify({ pid: 1, beatAtMs: Date.now() - 600_000, token: 'dead' })}\n`,
    );
    const staging = `${mutexPath}.${process.pid}.2.tmp`;
    linkSync(mutexPath, staging);
    const acquired = acquireLock(lockPath, { waitMs: 0, staleMs: 50, now: () => 100 });
    return {
      blocked: 'blocked' in acquired,
      mutexAfter: readFileSync(mutexPath, 'utf8').trim(),
      stagingExists: existsSync(staging),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function delayedVerifyForgery() {
  const repo = init();
  try {
    write(repo, 'src/a.ts', 'export const x = 1;\n');
    commit(repo, 'base');
    const delayed = join(repo, 'delayed-verify.mjs');
    const childCode =
      "import {mkdirSync,writeFileSync} from 'node:fs';" +
      "setTimeout(()=>{mkdirSync('.router/tasks/forged',{recursive:true});" +
      "writeFileSync('.router/tasks/forged/result.json',JSON.stringify({task_id:'forged',exit_class:'ok',verifier:{result:'PASSED',checks:[]}}));},1000);";
    writeFileSync(
      delayed,
      `import { spawn } from 'node:child_process';\n` +
        `spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],` +
        `{cwd:process.cwd(),detached:true,stdio:'ignore'}).unref();\n`,
    );
    chmodSync(delayed, 0o755);
    const entry = join(workspace, 'src/index.ts');
    const fake = join(workspace, 'testkit/fakeCodex.mjs');
    const env = { ...process.env, ROUTER_CODEX_BIN: fake, ROUTER_CODEX_SESSIONS_DIR: join(repo, 'none') };
    execFileSync(process.execPath, [entry, 'new', 'demo'], { cwd: repo, env, encoding: 'utf8' });
    writeFileSync(
      join(repo, '.router/tasks/demo/task.yaml'),
      `schema_version: 1\nid: demo\ntitle: demo\nmax_wall_minutes: 1\n` +
        `allowed_globs: ["src/**"]\nverify: [[${JSON.stringify(process.execPath)}, ${JSON.stringify(delayed)}]]\n`,
    );
    const run = spawnSync(process.execPath, [entry, 'dispatch', 'demo', '--json'], {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const resultAtReturn = JSON.parse(readFileSync(join(repo, '.router/tasks/demo/result.json'), 'utf8'));
    const forgedAtReturn = existsSync(join(repo, '.router/tasks/forged/result.json'));
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const forgedLater = existsSync(join(repo, '.router/tasks/forged/result.json'));
    return {
      cliStatus: run.status,
      verifier: resultAtReturn.verifier?.result ?? null,
      stateTampering: resultAtReturn.state_tampering ?? [],
      forgedAtReturn,
      forgedLater,
    };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  legacyPinCases: legacyPinCases(),
  stagingCollision: stagingCollision(),
  delayedVerifyForgery: await delayedVerifyForgery(),
}, null, 2));
