// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

// One-shot headless claude call for planning. Unlike the executor, the planner needs
// NO file/tool permissions: it only consumes the prompt and returns text.
// `claude -p <prompt> --output-format json` prints an envelope whose `.result` is the
// assistant's final text. ROUTER_CLAUDE_BIN overrides the binary (tests).
export function invokeClaudePlanner(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; text: string; error?: string } {
  const bin = env.ROUTER_CLAUDE_BIN ?? 'claude';
  try {
    const out = execFileSync(bin, ['-p', prompt, '--output-format', 'json'], {
      encoding: 'utf8',
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    try {
      const envelope = JSON.parse(out) as { result?: unknown };
      if (typeof envelope.result === 'string') return { ok: true, text: envelope.result };
    } catch {
      // fall through: treat raw stdout as the text
    }
    return { ok: true, text: out };
  } catch (e) {
    return { ok: false, text: '', error: (e as Error).message };
  }
}
