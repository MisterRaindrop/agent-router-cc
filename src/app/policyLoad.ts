import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { Policy } from '../domain/types.ts';
import { ROUTER_DIR } from '../domain/constants.ts';
import { validatePolicy } from '../domain/validate.ts';
import { showFileAtRev } from '../io/git.ts';
import type { RouterPaths } from '../io/paths.ts';

// Loading policy.yaml. The security-critical read (used by the verifier for the
// command whitelist and forbidden globs) comes from the git object at base_sha,
// NOT the worktree — so a worker cannot loosen the rules by editing its checkout.
// JSON_SCHEMA is used so no `!!js/*` YAML tags can execute code.

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

// git wants a forward-slash, repo-relative path regardless of OS.
const POLICY_REL = `${ROUTER_DIR}/policy.yaml`;

function parseAndValidate(source: string, yamlText: string): Policy {
  let data: unknown;
  try {
    data = load(yamlText, { schema: JSON_SCHEMA });
  } catch (err) {
    throw new PolicyError(`policy YAML parse error (${source}): ${(err as Error).message}`);
  }
  const r = validatePolicy(data);
  if (!r.ok || r.value === null) {
    throw new PolicyError(`invalid policy (${source}): ${r.errors.join('; ')}`);
  }
  return r.value;
}

/** Authoritative load: policy.yaml as committed at base_sha (tamper-proof). */
export function loadPolicyFromGit(paths: RouterPaths, baseSha: string): Policy {
  const repoRoot = dirname(paths.root);
  const text = showFileAtRev(repoRoot, baseSha, POLICY_REL);
  if (text === null) {
    throw new PolicyError(`policy.yaml not found at ${baseSha}:${POLICY_REL}`);
  }
  return parseAndValidate(`git ${baseSha.slice(0, 12)}:${POLICY_REL}`, text);
}

/** Operational load from the working copy (init-time / non-security reads only). */
export function loadPolicyFromDisk(paths: RouterPaths): Policy {
  if (!existsSync(paths.policy)) {
    throw new PolicyError(`policy.yaml not found at ${paths.policy}`);
  }
  return parseAndValidate(paths.policy, readFileSync(paths.policy, 'utf8'));
}
