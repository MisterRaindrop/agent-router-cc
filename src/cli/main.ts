import { flagBool, parseArgs } from './args.ts';
import { HANDLERS, helpText, versionText } from './commands.ts';
import { CliError, err, out } from './output.ts';

export async function runCli(argv: string[], cwd: string = process.cwd()): Promise<number> {
  const first = argv[0];
  if (first === '--version' || first === '-V') {
    out(versionText());
    return 0;
  }
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    out(helpText());
    return first === undefined ? 1 : 0;
  }

  const parsed = parseArgs(argv);
  const handler = HANDLERS[parsed.verb ?? ''];
  if (handler === undefined) {
    err(`router: unknown command '${parsed.verb}'`);
    return 2;
  }

  const json = flagBool(parsed.flags, 'json');
  try {
    return await handler({ args: parsed, cwd, json });
  } catch (e) {
    if (e instanceof CliError) {
      if (json) out(JSON.stringify({ ok: false, error: e.message }));
      else err(`router: ${e.message}`);
      return e.code;
    }
    err(`router: ${(e as Error).message}`);
    return 1;
  }
}
