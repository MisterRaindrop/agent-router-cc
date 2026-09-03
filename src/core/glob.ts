// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Minimal glob matcher over forward-slash paths. PURE.
//   **   matches zero or more path segments
//   *    matches within a single segment (not '/')
//   ?    matches a single non-'/' char
// Dotfiles are matched like any other name (git semantics).
//
// EVERY pattern is anchored at the repository root, and this is where it differs from gitignore in
// the one way that catches people. In gitignore a pattern with no slash matches a file of that name
// at ANY depth, so `CMakeLists.txt` covers the whole tree; here it covers exactly the root one, and
// the tree needs `**/CMakeLists.txt`. Measured on ClickHouse, where a commit touching only
// `src/CMakeLists.txt` selected the incremental gate under a `clean_triggers` list that read
// `CMakeLists.txt` -- a build file changed and the build was not redone.
//
// The anchoring is not a defect: `allowed_globs` wants `src/app/**` to mean exactly that, and the
// scope gate is the one check that must not match more than it says. It is the DESCRIPTION that was
// wrong, and callers that let a human write patterns have to say so -- see `clean_triggers`.

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
