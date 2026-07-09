import { runCli } from './cli/main.ts';

process.exitCode = await runCli(process.argv.slice(2));
