// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Build the Claude Code `statusLine.command` that runs router's usage-snapshot
// wrapper (statusline/router-usage.mjs). If the user already has a statusline, it
// is chained via ROUTER_INNER_STATUSLINE so their existing HUD keeps rendering.
// PURE: string-building only; the cli layer does the settings.json read/write.

const MARKER = 'router-usage.mjs';

export type StatusLineAction = 'created' | 'chained' | 'already-configured';

export interface StatusLinePlan {
  command: string; // the statusLine.command to write
  action: StatusLineAction;
  inner: string | null; // the pre-existing command we chained, if any
}

/** POSIX single-quote a string for safe embedding in a shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decide the statusLine command given the current one (if any) and the absolute
 * path to router-usage.mjs. Idempotent: if the current command already runs our
 * wrapper, it is left untouched (so a chained inner statusline is never clobbered).
 */
export function planStatusLine(
  existingCommand: string | undefined,
  statuslinePath: string,
): StatusLinePlan {
  const wrapped = `node ${shQuote(statuslinePath)}`;
  const current = existingCommand?.trim();
  if (current === undefined || current === '') {
    return { command: wrapped, action: 'created', inner: null };
  }
  if (current.includes(MARKER)) {
    return { command: current, action: 'already-configured', inner: null };
  }
  return {
    command: `ROUTER_INNER_STATUSLINE=${shQuote(current)} ${wrapped}`,
    action: 'chained',
    inner: current,
  };
}
