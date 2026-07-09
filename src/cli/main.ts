import { VERSION } from '../domain/constants.ts';

/**
 * Entry dispatcher. Returns a process exit code.
 * M1 verbs land in later build steps; step 0 wires only --version/--help so the
 * committed bundle is runnable on bare Node.
 */
export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === '--version' || cmd === '-V') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === undefined) {
    printHelp();
    return 1;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return 0;
  }
  process.stderr.write(`router: unknown command '${cmd}'\n`);
  return 2;
}

function printHelp(): void {
  process.stdout.write(
    `router ${VERSION}\n\n` +
      `Usage: router <command> [options]\n\n` +
      `Deterministic task orchestration. Commands land across M1 build steps.\n`,
  );
}
