// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { ModelSpec } from '../domain/types.ts';

// The codex CLI as an external writer: argv for a fresh run and for a resume, and the one pass
// over its JSONL stream that `router write` needs. The binary is `codex` by default;
// ROUTER_CODEX_BIN overrides it, which is how the tests substitute a fake writer.

/** What `router write` reads back out of a codex `--json` stream. */
export interface CodexLog {
  model: string | null;
  /** codex's thread id -- what a resume re-attaches to, and the proof that it did. */
  sessionId: string | null;
  finalMessage?: string;
}

function bin(): string {
  return process.env.ROUTER_CODEX_BIN ?? 'codex';
}

function pin(argv: string[], m: ModelSpec): string[] {
  argv.push('-m', m.model);
  if (m.effort !== undefined) argv.push('-c', `model_reasoning_effort=${m.effort}`);
  return argv;
}

/**
 * A fresh, non-interactive run in the repository root, under the `workspace-write` sandbox: it
 * can edit files and commit, and cannot write outside the checkout.
 */
export function codexWriteArgv(prompt: string, cwd: string, m: ModelSpec): string[] {
  return pin([bin(), 'exec', prompt, '-C', cwd, '-s', 'workspace-write', '--skip-git-repo-check', '--json'], m);
}

/**
 * `codex exec resume <session-id> <prompt>` continues that rollout. Its flags are NOT the same as
 * `codex exec`'s, which a real run proved: `exec resume` rejects `-C` outright ("unexpected
 * argument '-C' found") and has no `-s`, so an earlier version of this path never worked against
 * the real CLI while the fakes were happy with it. The working directory comes from the spawn,
 * and the sandbox is expressed as a config override -- verified honoured, the run header reports
 * the mode it was given.
 */
export function codexResumeArgv(sessionId: string, feedback: string, m: ModelSpec): string[] {
  return pin(
    [bin(), 'exec', 'resume', sessionId, feedback, '-c', 'sandbox_mode=workspace-write', '--skip-git-repo-check', '--json'],
    m,
  );
}

/** Single pass over the stream: model slug, session id, and the writer's last message. */
export function parseCodexLog(logText: string): CodexLog {
  let model: string | null = null;
  let sessionId: string | null = null;
  let finalMessage: string | undefined;
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as {
      type?: string;
      model?: unknown;
      thread?: { model?: unknown; id?: unknown };
      turn?: { model?: unknown };
      session_id?: unknown;
      thread_id?: unknown;
      session?: { id?: unknown };
      item?: { type?: unknown; text?: unknown };
    };
    if (model === null) {
      const v = rec.model ?? rec.thread?.model ?? rec.turn?.model;
      if (typeof v === 'string' && v !== '') model = v;
    }
    if (sessionId === null) {
      const v = rec.session_id ?? rec.thread_id ?? rec.thread?.id ?? rec.session?.id;
      if (typeof v === 'string' && v !== '') sessionId = v;
    }
    if (rec.type === 'item.completed' && rec.item?.type === 'agent_message' && typeof rec.item.text === 'string') {
      finalMessage = rec.item.text;
    }
  }
  return { model, sessionId, ...(finalMessage !== undefined ? { finalMessage } : {}) };
}
