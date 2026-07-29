// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Bundle src/index.ts -> dist/router.js as a single committed file.
// Users need only Node >= 18 and NO npm install: all pure-JS deps (js-yaml, ajv) are
// inlined here. web-tree-sitter is the exception -- its emscripten glue + wasm do not
// bundle, so we VENDOR the three runtime files into dist/vendor/ and load them at
// runtime (see src/io/treeSitter.ts). They ship via package.json `files: ["dist/"]`,
// so it's still zero-install. See the design doc's "supply-chain surface" principle.
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
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

// Vendor the tree-sitter runtime + cpp grammar next to the bundle.
const require = createRequire(import.meta.url);
const wtsDir = dirname(require.resolve('web-tree-sitter'));
const cppWasm = require.resolve('tree-sitter-wasms/out/tree-sitter-cpp.wasm');
const vendor = fileURLToPath(new URL('../dist/vendor/', import.meta.url));
mkdirSync(vendor, { recursive: true });
for (const [from, to] of [
  [join(wtsDir, 'tree-sitter.js'), 'tree-sitter.js'],
  [join(wtsDir, 'tree-sitter.wasm'), 'tree-sitter.wasm'],
  [cppWasm, 'tree-sitter-cpp.wasm'],
]) {
  copyFileSync(from, join(vendor, to));
}

console.log(`built dist/router.js (v${pkg.version}) + vendored tree-sitter wasm`);
