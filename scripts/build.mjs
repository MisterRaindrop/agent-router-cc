// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Bundle src/index.ts -> dist/router.js as a single committed file.
// Users need only Node >= 18 and NO npm install: all pure-JS deps (js-yaml, ajv) are
// inlined here. web-tree-sitter is the exception -- its emscripten glue + wasm do not
// bundle, so we VENDOR the three runtime files into dist/vendor/ and load them at
// runtime (see src/io/treeSitter.ts). They ship via package.json `files: ["dist/"]`,
// so it's still zero-install. See the design doc's "supply-chain surface" principle.
import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/router.js',
  // web-tree-sitter (emscripten glue) is loaded at runtime from dist/vendor via a
  // computed dynamic import, never bundled. Mark external so esbuild never tries.
  external: ['web-tree-sitter', 'tree-sitter-wasms'],
  // CJS deps (ajv) need require() available inside an ESM bundle.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __routerCreateRequire } from 'node:module';",
      'const require = __routerCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    __ROUTER_VERSION__: JSON.stringify(pkg.version),
  },
  legalComments: 'none',
});

// The statusline runs as a standalone script, while dist/router.js is an executable CLI bundle
// with top-level side effects. Publish the frozen activity observation API as its own import-safe
// bundle so the statusline can reuse the one liveness rule without running the CLI.
await esbuild.build({
  entryPoints: ['src/io/activity.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/statusline-activity.mjs',
  legalComments: 'none',
});

// Vendor the tree-sitter runtime + cpp grammar next to the bundle.
const require = createRequire(import.meta.url);
const wtsDir = dirname(require.resolve('web-tree-sitter'));
const cppWasm = require.resolve('tree-sitter-wasms/out/tree-sitter-cpp.wasm');
const vendor = fileURLToPath(new URL('../dist/vendor/', import.meta.url));
mkdirSync(vendor, { recursive: true });
// web-tree-sitter renamed its entry + wasm in 0.26 (tree-sitter.* -> web-tree-sitter.*).
// Copy whichever the installed version ships, under the canonical vendor names, so the
// vendor layout (and treeSitter.ts's vendor branch) stays stable across upgrades.
const wtsRuntime = (suffix) => {
  for (const base of ['web-tree-sitter', 'tree-sitter']) {
    const candidate = join(wtsDir, base + suffix);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`web-tree-sitter: no *${suffix} runtime file in ${wtsDir}`);
};
for (const [from, to] of [
  [wtsRuntime('.js'), 'tree-sitter.js'],
  [wtsRuntime('.wasm'), 'tree-sitter.wasm'],
  [cppWasm, 'tree-sitter-cpp.wasm'],
]) {
  copyFileSync(from, join(vendor, to));
}

console.log(
  `built dist/router.js (v${pkg.version}) + dist/statusline-activity.mjs + vendored tree-sitter wasm`,
);
