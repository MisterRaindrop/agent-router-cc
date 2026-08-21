// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Environment whitelists. Verification commands run repository-controlled code,
// so they receive only the small base environment. Executor CLIs additionally
// need OS login-session and network context to reuse plan authentication, but we
// still never pass the full parent environment (which may contain unrelated
// credentials such as AWS_*).

const BASE_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'TERM'];

const EXECUTOR_CONTEXT_ALLOW = [
  'USER',
  'LOGNAME',
  'SHELL',
  // macOS Keychain/session lookup used by native Claude Code.
  'SECURITYSESSIONID',
  'LaunchInstanceID',
  'XPC_FLAGS',
  'XPC_SERVICE_NAME',
  '__CF_USER_TEXT_ENCODING',
  // Explicit config/certificate locations and update policy.
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'DISABLE_AUTO_UPDATE',
];

const PROXY_URL_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'];

function copy(source: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv, key: string): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

// A proxy URL with embedded userinfo is itself a credential. Do not expose one
// to a model-driven executor unless the user explicitly names that variable via
// api_key_env. Credential-free local/corporate proxy endpoints are safe context.
function proxyHasCredentials(value: string): boolean {
  if (!value.includes('://')) return value.includes('@');
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '';
  } catch {
    return true;
  }
}

export function buildWorkerEnv(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ALLOW, ...extraKeys]) copy(source, out, key);
  return out;
}

/**
 * Set in every executor environment so a nested `router` invocation refuses to touch
 * orchestration state. See the check in cli/commands.ts depsFor().
 */
export const EXECUTOR_SANDBOX_ENV = 'ROUTER_EXECUTOR_SANDBOX';

/** Environment for the trusted executor CLI (codex/claude), not verifier commands. */
export function buildExecutorEnv(
  source: NodeJS.ProcessEnv,
  extraKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const out = buildWorkerEnv(source);
  // Marked here rather than at the call site because this is the single funnel every
  // executor environment goes through -- a per-call flag is a flag somebody forgets.
  out[EXECUTOR_SANDBOX_ENV] = '1';
  for (const key of EXECUTOR_CONTEXT_ALLOW) copy(source, out, key);
  for (const key of NO_PROXY_KEYS) copy(source, out, key);
  for (const key of PROXY_URL_KEYS) {
    const value = source[key];
    if (value !== undefined && !proxyHasCredentials(value)) out[key] = value;
  }
  // Explicit opt-in wins, including for a credential-bearing proxy or API token.
  for (const key of extraKeys) copy(source, out, key);
  return out;
}
