// Bundle src/index.ts -> dist/router.js as a single committed file.
// Users need only Node >= 18 and NO npm install: all deps (js-yaml, ajv) are
// inlined here. See the design doc's "供应链面收敛" principle.
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
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

console.log(`built dist/router.js (v${pkg.version})`);
