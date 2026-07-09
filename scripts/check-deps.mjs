// Dependency-direction guard: src/core/** must stay PURE.
// No fs, no child_process, no process.*, no wall-clock / randomness reads.
// This is what makes gate logic unit-testable without git/codex AND
// structurally guarantees the LLM cannot influence a state transition.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CORE_DIR = 'src/core';

const FORBIDDEN = [
  { re: /from\s+['"](node:)?fs(\/promises)?['"]/, msg: "imports 'fs'" },
  { re: /from\s+['"](node:)?child_process['"]/, msg: "imports 'child_process'" },
  { re: /from\s+['"](node:)?process['"]/, msg: "imports 'process'" },
  // Import-direction: core must not depend on the impure rings (io/app/cli).
  // Without this, core could import e.g. io/git and transitively shell out.
  { re: /from\s+['"][^'"]*\/(io|app|cli)\//, msg: 'imports an impure ring (io/app/cli)' },
  { re: /\bchild_process\b/, msg: 'references child_process' },
  { re: /\bprocess\.(env|cwd|kill|exit|argv)\b/, msg: 'reads process.*' },
  { re: /\bDate\.now\b/, msg: 'reads Date.now()' },
  { re: /\bnew Date\(\s*\)/, msg: 'reads wall clock via new Date()' },
  { re: /\bMath\.random\b/, msg: 'uses Math.random()' },
];

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // core dir may not exist yet in early build steps
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let violations = 0;
for (const file of walk(CORE_DIR)) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const { re, msg } of FORBIDDEN) {
      if (re.test(line)) {
        console.error(`${file}:${i + 1}: core purity violation — ${msg}\n    ${line.trim()}`);
        violations++;
      }
    }
  });
}

if (violations > 0) {
  console.error(`\ncheck:deps FAILED — ${violations} core-purity violation(s).`);
  process.exit(1);
}
console.log('check:deps OK — src/core is pure.');
