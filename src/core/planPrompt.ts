// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { RepoDigest } from '../domain/types.ts';

// Builds the planner prompt (PURE). The planner must return ONLY a JSON contract;
// router validates that artifact deterministically (see core/planCheck.ts).
export function buildPlannerPrompt(digest: RepoDigest, goal: string): string {
  const refs = digest.verificationRefs.join(', ');
  const lines = [
    'You are a planning assistant for a deterministic coding-task router.',
    'Decompose the GOAL into the SMALLEST set of tasks (1..N; one task is fine).',
    'Respond with ONLY a single JSON object -- no prose, no markdown, no code fences:',
    '{ "tasks": [ <task>, ... ] }',
    '',
    'Each <task> has:',
    '  "id": "kebab-case-slug", "title": "short imperative title",',
    '  "clarity": "clear" | "unclear",',
    '  "depends_on": ["ids of tasks in THIS response that must merge first"],',
    'and, when clarity is "clear" (well-bounded, mechanically checkable):',
    '  "allowed_globs": ["smallest set of path globs"], "forbidden_globs": [],',
    `  "max_changed_lines": 100, "build_ref": "one of: ${refs}", "test_ref": "one of: ${refs}",`,
    '  "contract_md": "markdown with a Goal section and a Definition of Done checklist"',
    'or, when clarity is "unclear" (needs human judgment/design first):',
    '  "reason": "what must be clarified before this can be dispatched"',
    '',
    'Constraints:',
    '- Mark a task "clear" ONLY if an average model could finish it from the contract alone.',
    '- allowed_globs must be minimal and match existing files; never use a bare "**".',
    '- build_ref and test_ref MUST be chosen from the list above.',
    '- depends_on may only reference ids in this same response; no cycles.',
    '',
    `GOAL: ${goal}`,
    '',
    'Repository files (git-tracked):',
    digest.files.join('\n'),
  ];
  if (digest.truncated) lines.push('(file list truncated)');
  if (digest.readmeHead !== undefined && digest.readmeHead !== '') {
    lines.push('', 'README (head):', digest.readmeHead);
  }
  return lines.join('\n');
}
