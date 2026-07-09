#!/usr/bin/env node
import { createRequire as __routerCreateRequire } from 'node:module';
const require = __routerCreateRequire(import.meta.url);

// src/domain/constants.ts
var VERSION = true ? "0.1.0" : "0.0.0-dev";

// src/cli/main.ts
async function runCli(argv) {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-V") {
    process.stdout.write(`${VERSION}
`);
    return 0;
  }
  if (cmd === void 0) {
    printHelp();
    return 1;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }
  process.stderr.write(`router: unknown command '${cmd}'
`);
  return 2;
}
function printHelp() {
  process.stdout.write(
    `router ${VERSION}

Usage: router <command> [options]

Deterministic task orchestration. Commands land across M1 build steps.
`
  );
}

// src/index.ts
process.exitCode = await runCli(process.argv.slice(2));
