// Env whitelist (design F3.3). A worker / verification command inherits ONLY a
// minimal, explicit set of variables plus the single API key it needs — never
// the full session env (which would leak ANTHROPIC_API_KEY / AWS_* / etc. to the
// child).

const BASE_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'TERM'];

export function buildWorkerEnv(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ALLOW, ...extraKeys]) {
    const v = source[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
