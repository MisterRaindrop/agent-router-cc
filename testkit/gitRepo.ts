// Synthetic git-repo fixture harness for tests. Builds real temp repos so the
// git wrappers, scope enforcement, and verifier can be exercised without codex.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

export function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'router-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@router.local']);
  git(dir, ['config', 'user.name', 'Router Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function writeBinary(dir: string, rel: string, bytes: Uint8Array): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

export function rm(dir: string, rel: string): void {
  git(dir, ['rm', '-q', '--', rel]);
}

export function mv(dir: string, from: string, to: string): void {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  git(dir, ['mv', from, to]);
}

export function addCommit(dir: string, msg: string): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg, '--allow-empty']);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
