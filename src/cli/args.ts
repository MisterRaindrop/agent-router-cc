// Tiny hand-rolled argv parser (no dependency). Flag arities are declared so a
// value-flag consumes the next token while a boolean-flag does not — this avoids
// ambiguity like `run --json t1` swallowing the positional.

const BOOLEAN_FLAGS = new Set(['json', 'force', 'keep', 'help']);
const VALUE_FLAGS = new Set(['id', 'title', 'run', 'attempt', 'since', 'router-dir']);

export interface ParsedArgs {
  verb: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const verb = argv[0];
  const rest = argv.slice(1);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else if (VALUE_FLAGS.has(body)) {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = '';
        }
      } else {
        // Unknown flag: assume boolean.
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { verb, positionals, flags };
}

export function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}
