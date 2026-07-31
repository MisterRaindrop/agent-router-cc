// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { matchAny } from './glob.ts';

export type Risk = 'low' | 'normal' | 'high';

export interface RiskSignals {
  changedLines: number;
  changedPaths: string[];
  invariantGlobs: string[];
}

const RANK: Record<Risk, number> = { low: 0, normal: 1, high: 2 };

// These are coarse tripwires for review routing, not a calibrated risk model.
const CHANGED_LINES_TRIPWIRE = 300;
const TOP_LEVEL_DIRECTORIES_TRIPWIRE = 4;

function raise(current: Risk, floor: Risk): Risk {
  return RANK[current] >= RANK[floor] ? current : floor;
}

/** True when `floor` would actually lift `current`; `raisedBy` must not claim otherwise. */
function raises(current: Risk, floor: Risk): boolean {
  return RANK[floor] > RANK[current];
}

function topLevelDirectory(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

export function effectiveRisk(
  declared: Risk | undefined,
  signals: RiskSignals,
): { risk: Risk; raisedBy: string[] } {
  let risk = declared ?? 'normal';
  const raisedBy: string[] = [];

  const invariant = signals.invariantGlobs.find((glob) =>
    signals.changedPaths.some((path) => matchAny(path, [glob])),
  );
  if (invariant !== undefined) {
    if (raises(risk, 'high')) raisedBy.push(`invariant:${invariant}`);
    risk = raise(risk, 'high');
  }

  if (signals.changedLines > CHANGED_LINES_TRIPWIRE) {
    if (raises(risk, 'normal')) raisedBy.push(`changed_lines>${CHANGED_LINES_TRIPWIRE}`);
    risk = raise(risk, 'normal');
  }

  const directories = new Set(signals.changedPaths.map(topLevelDirectory));
  if (directories.size >= TOP_LEVEL_DIRECTORIES_TRIPWIRE) {
    if (raises(risk, 'normal')) raisedBy.push(`top_level_directories>=${TOP_LEVEL_DIRECTORIES_TRIPWIRE}`);
    risk = raise(risk, 'normal');
  }

  return { risk, raisedBy };
}
