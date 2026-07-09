import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Append-only JSONL. Each record is serialized to a single line and appended
// with O_APPEND, so a well-formed line is written atomically (POSIX guarantees
// atomicity for writes up to PIPE_BUF; our records are far smaller). A crash
// can at worst leave a trailing partial line, which readJsonl() drops.

export function appendJsonl(path: string, record: unknown): void {
  const line = JSON.stringify(record);
  if (line.includes('\n')) {
    // JSON.stringify never emits raw newlines, but guard the invariant loudly.
    throw new Error('jsonl record serialized with an embedded newline');
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, { flag: 'a' });
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip a torn trailing line from an interrupted append.
    }
  }
  return out;
}
