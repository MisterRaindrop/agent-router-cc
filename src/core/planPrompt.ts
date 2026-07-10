// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { RepoDigest } from '../domain/types.ts';

// Builds the planner prompt (PURE). The planner must return ONLY a JSON contract;
// router validates that artifact deterministically (see core/planCheck.ts).
export function buildPlannerPrompt(digest: RepoDigest, goal: string): string {
  const refs = digest.verificationRefs.join(', ');
  const lines = [
    'You are a planning assistant for a deterministic coding-task router.',
    'Turn the GOAL into exactly ONE task contract.',
    'Respond with ONLY a single JSON object -- no prose, no markdown, no code fences.',
    '',
    'JSON shape:',
    '{',
    '  "id": "kebab-case-slug",',
    '  "title": "short imperative title",',
    '  "allowed_globs": ["smallest set of path globs that can satisfy the goal"],',
    '  "forbidden_globs": [],',
    '  "max_changed_lines": 100,',
    `  "build_ref": "one of: ${refs}",`,
    `  "test_ref": "one of: ${refs}",`,
    '  "contract_md": "markdown with a Goal section and a Definition of Done checklist"',
    '}',
    '',
    'Constraints:',
    '- allowed_globs must be minimal and match existing files; never use a bare "**".',
    '- build_ref and test_ref MUST be chosen from the list above.',
    '- max_changed_lines is a positive integer sized to the goal.',
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
