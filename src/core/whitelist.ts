// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { WhitelistTemplate } from '../domain/types.ts';

// Command whitelist. verification_commands are NOT free text from the LLM - the
// only runnable commands are argv templates checked into policy.yaml. router
// instantiates a template with task-supplied placeholder values, each of which
// is type-checked here. Combined with shell:false execution (io/proc), this
// closes the "LLM-authored command => arbitrary code execution" hole. PURE.

const PLACEHOLDER = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export interface InstantiateResult {
  ok: boolean;
  argv: string[] | null;
  errors: string[];
}

/** Validate a value substituted for a placeholder. Returns error strings (empty = ok). */
export function validatePlaceholderValue(name: string, value: string): string[] {
  const errors: string[] = [];
  if (value === '') errors.push(`{${name}}: empty value`);
  if (value.startsWith('-')) errors.push(`{${name}}: value may not start with '-' (option injection)`);
  if (CONTROL_CHARS.test(value)) errors.push(`{${name}}: control characters not allowed`);
  if (value.startsWith('/')) errors.push(`{${name}}: absolute paths not allowed`);
  if (value.split('/').includes('..')) errors.push(`{${name}}: '..' path segments not allowed`);
  return errors;
}

/**
 * Instantiate an argv template with placeholder values. Literal tokens pass
 * through; a token that is exactly `{name}` is replaced by params[name] (a whole
 * argument - no partial interpolation, so a value can never inject extra argv).
 */
export function instantiateTemplate(
  template: WhitelistTemplate,
  params: Record<string, string>,
): InstantiateResult {
  const errors: string[] = [];
  const argv: string[] = [];

  if (template.length === 0) {
    return { ok: false, argv: null, errors: ['empty command template'] };
  }

  // The program name (argv[0]) must be a literal, never a placeholder.
  if (PLACEHOLDER.test(template[0]!)) {
    errors.push('command program (argv[0]) must be a literal, not a placeholder');
  }

  for (const token of template) {
    const m = PLACEHOLDER.exec(token);
    if (m === null) {
      argv.push(token); // literal
      continue;
    }
    const name = m[1]!;
    const value = params[name];
    if (value === undefined) {
      errors.push(`missing verification_param: ${name}`);
      continue;
    }
    errors.push(...validatePlaceholderValue(name, value));
    argv.push(value);
  }

  return errors.length === 0
    ? { ok: true, argv, errors: [] }
    : { ok: false, argv: null, errors };
}
