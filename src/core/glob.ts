// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Minimal gitignore-style glob matcher over forward-slash paths. PURE.
//   **   matches zero or more path segments
//   *    matches within a single segment (not '/')
//   ?    matches a single non-'/' char
// Dotfiles are matched like any other name (git semantics).

const cache = new Map<string, RegExp>();
const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

function compile(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;

  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // `**/` => zero or more whole segments
          i += 3;
        } else if (i + 2 >= glob.length) {
          re += '.*'; // trailing `**` (e.g. `src/**`) => anything, incl. '/'
          i += 2;
        } else {
          re += '[^/]*'; // `**` mid-segment, not on a boundary => single segment
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (REGEX_SPECIAL.has(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += '$';
  const compiled = new RegExp(re);
  cache.set(glob, compiled);
  return compiled;
}

export function matchGlob(path: string, glob: string): boolean {
  return compile(glob).test(path);
}

export function matchAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => compile(g).test(path));
}
