// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Build the Claude Code `statusLine.command` that runs router's usage-snapshot
// wrapper (statusline/router-usage.mjs). If the user already has a statusline, it
// is chained via ROUTER_INNER_STATUSLINE so their existing HUD keeps rendering.
// PURE: string-building only; the cli layer does the settings.json read/write.

const MARKER = 'router-usage.mjs';
// What we write when the field is ABSENT. Not what we impose when it is present.
//
// 2 was chosen from a measurement of the chained statusline that was wrong by more than a factor
// of ten. Measured properly on the maintainer's machine: the chained claude-hud runs `git status`
// on every render and takes a median of 1206ms in this repository, so a 2-second interval never
// finished before the next render started -- five statusline processes accumulated and the load
// average went past 130, which then failed four timing-sensitive tests in the suite.
//
// The honest conclusion is that the right interval depends on what the user chained and how big
// their repository is, and router cannot measure either. So: write a conservative default, and
// leave any value the user already chose alone.
const REFRESH_INTERVAL_SECONDS = 10 as const;

export type StatusLineAction = 'created' | 'chained' | 'already-configured' | 'repointed' | 'updated';

export interface StatusLineSettings {
  type: 'command';
  command: string;
  refreshInterval: number;
}

export interface StatusLinePlan {
  command: string; // the statusLine.command to write
  statusLine: StatusLineSettings; // all fields owned by setup-statusline
  action: StatusLineAction;
  inner: string | null; // the pre-existing command we chained, if any
}

/** Any positive finite number is a choice we respect; anything else we replace. */
function validInterval(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

interface ExistingStatusLineSettings {
  type?: unknown;
  refreshInterval?: unknown;
}

/**
 * Matches `.../plugins/cache/<marketplace>/<plugin>/<version>/statusline/router-usage.mjs`.
 *
 * An installed plugin lives under a directory named for its version, so writing that absolute
 * path into settings.json pins the statusline to one release. The next upgrade installs beside it
 * and the old directory stays -- so the pinned path keeps working while running last release's
 * script, forever, silently. That is the same failure this project has now shipped twice (a
 * bundle self-reporting the previous version; a statusline scanning a path that had moved), and
 * it is invisible precisely because nothing breaks.
 */
const VERSIONED_PLUGIN_SCRIPT =
  /^(?<cache>.*[/\\]plugins[/\\]cache[/\\][^/\\]+[/\\][^/\\]+)[/\\][^/\\]+[/\\](?<tail>statusline[/\\]router-usage\.mjs)$/;

/** POSIX single-quote a string for safe embedding in a shell command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The invocation to write for `statuslinePath`.
 *
 * For a plugin install, resolve the newest version at RUN time rather than baking today's
 * version into settings.json -- the same thing claude-hud's own command does, and for the same
 * reason. Highest version wins by numeric field sort (`sort -t. -k1,1n -k2,2n -k3,3n`), which is
 * how `0.10.1` sorts above `0.8.5`; a lexical sort would pick `0.8.5`.
 *
 * Anything else -- a git checkout, or an explicit `--statusline` path -- gets the plain command.
 * There is no version directory to resolve, and a glob over one would be a guess.
 */
export function statusLineInvocation(statuslinePath: string): string {
  const m = VERSIONED_PLUGIN_SCRIPT.exec(statuslinePath);
  if (m?.groups === undefined) return `node ${shQuote(statuslinePath)}`;
  const { cache, tail } = m.groups as { cache: string; tail: string };
  const pipeline =
    `d=$(ls -d ${shQuote(cache)}/*/ 2>/dev/null` +
    ` | awk -F/ '{ print $(NF-1) "\t" $0 }'` +
    ` | sort -t. -k1,1n -k2,2n -k3,3n | tail -1 | cut -f2-);` +
    ` exec node "\${d}${tail.replaceAll('\\', '/')}"`;
  return `sh -c ${shQuote(pipeline)}`;
}

/**
 * Decide the statusLine command given the current one (if any) and the absolute
 * path to router-usage.mjs.
 *
 * Idempotent, but NOT blindly: a command that already runs our wrapper is left untouched only
 * when it is the command we would write now. A version-pinned one from an older release is
 * **repointed**, carrying its chained inner statusline across. Reporting that as
 * `already-configured` -- which it used to -- meant the one obvious repair (`run setup again`)
 * silently did nothing, so a stranded statusline could only be fixed by hand-editing
 * settings.json.
 */
export function planStatusLine(
  existingCommand: string | undefined,
  statuslinePath: string,
  existingSettings?: ExistingStatusLineSettings,
): StatusLinePlan {
  const wrapped = statusLineInvocation(statuslinePath);
  const current = existingCommand?.trim();
  if (current === undefined || current === '') {
    return plan(wrapped, 'created', null, existingSettings);
  }
  if (current.includes(MARKER)) {
    if (current === wrapped || current.endsWith(` ${wrapped}`)) {
      // A refresh interval the user already set is THEIRS -- see the constant above. We only
      // supply one when the field is missing entirely, so re-running this command can repair a
      // config that predates the field without overriding a deliberate choice.
      const managedFieldsMatch =
        existingSettings?.type === 'command' && validInterval(existingSettings.refreshInterval);
      return plan(current, managedFieldsMatch ? 'already-configured' : 'updated', null, existingSettings);
    }
    // Ours, but not what we would write now. Keep whatever it chained.
    const inner = extractInner(current);
    return plan(
      inner === null ? wrapped : `ROUTER_INNER_STATUSLINE=${shQuote(inner)} ${wrapped}`,
      'repointed',
      inner,
      existingSettings,
    );
  }
  return plan(`ROUTER_INNER_STATUSLINE=${shQuote(current)} ${wrapped}`, 'chained', current, existingSettings);
}

function plan(
  command: string,
  action: StatusLineAction,
  inner: string | null,
  existing?: ExistingStatusLineSettings,
): StatusLinePlan {
  // Carry the user's own interval through, or supply the default when they have none. Writing
  // REFRESH_INTERVAL_SECONDS unconditionally here is what would silently override their choice,
  // because the cli layer merges this object over the existing one.
  const refreshInterval = validInterval(existing?.refreshInterval)
    ? (existing?.refreshInterval as number)
    : REFRESH_INTERVAL_SECONDS;
  return {
    command,
    statusLine: { type: 'command', command, refreshInterval },
    action,
    inner,
  };
}

/** Recover the inner statusline from a command we wrote earlier, or null if it chained none. */
function extractInner(command: string): string | null {
  const m = /^ROUTER_INNER_STATUSLINE='((?:[^']|'\\'')*)'\s/.exec(command);
  if (m?.[1] === undefined) return null;
  return m[1].replaceAll(`'\\''`, `'`);
}
