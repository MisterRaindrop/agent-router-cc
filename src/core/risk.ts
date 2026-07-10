// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { matchAny } from './glob.ts';

// Glob-derived risk classification. PURE: a task's allowed_globs -> a risk level.
// A task is HIGH risk when its allowed_globs could touch a sensitive path (a
// lockfile, CI config, a migration, package manifests). We test each sensitive
// SAMPLE path against the globs, which correctly flags both a narrow glob
// (".github/**") and an over-broad one ("**") while leaving a scoped "src/**"
// task low. The app requires an explicit approval before merging a high-risk task.

export type RiskLevel = 'low' | 'high';

export interface RiskVerdict {
  level: RiskLevel;
  reasons: string[]; // human labels for each sensitive area the globs can reach
}

const SENSITIVE: readonly { path: string; label: string }[] = [
  { path: 'package.json', label: 'package.json' },
  { path: 'package-lock.json', label: 'lockfile' },
  { path: 'pnpm-lock.yaml', label: 'lockfile' },
  { path: 'yarn.lock', label: 'lockfile' },
  { path: 'Cargo.lock', label: 'lockfile' },
  { path: 'go.sum', label: 'lockfile' },
  { path: 'poetry.lock', label: 'lockfile' },
  { path: '.github/workflows/ci.yml', label: 'CI config (.github)' },
  { path: '.gitlab-ci.yml', label: 'CI config' },
  { path: '.circleci/config.yml', label: 'CI config' },
  { path: 'migrations/0001_init.sql', label: 'migration' },
  { path: 'db/migrate/001_init.rb', label: 'migration' },
];

/** Classify a task's merge risk from its allowed_globs. PURE. */
export function classifyRisk(allowedGlobs: readonly string[]): RiskVerdict {
  const reasons: string[] = [];
  for (const s of SENSITIVE) {
    if (matchAny(s.path, allowedGlobs) && !reasons.includes(s.label)) {
      reasons.push(s.label);
    }
  }
  return { level: reasons.length > 0 ? 'high' : 'low', reasons };
}
