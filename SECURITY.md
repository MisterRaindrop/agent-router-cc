# Security Policy

router launches codex as an external writer in your checkout, under codex's `workspace-write`
sandbox and with a deliberately minimal environment. Bugs in either of those are security bugs,
and we want to hear about them.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via
[GitHub Security Advisories](https://github.com/MisterRaindrop/agent-router-cc/security/advisories/new)
("Report a vulnerability"). You should receive a response within a few days.

Please include:

- What the vulnerability lets an attacker (or a malicious/compromised writer) do.
- Reproduction steps or a proof of concept.
- The router version (`.claude-plugin/plugin.json`) and platform.

## Scope — what counts

Especially interesting:

- **Sandbox escapes:** a `router write` / `router resume` run writing outside the checkout or
  reaching the parent environment.
- **Credential leakage:** the writer receiving environment variables beyond the documented
  login-session context (`src/io/env.ts`).
- **Guard bypasses:** a writer driving a writing `router` verb despite `ROUTER_EXECUTOR_SANDBOX`,
  or a write starting over uncommitted work it promised to refuse.

Out of scope: vulnerabilities in the codex CLI itself, in
Claude Code, or in the models' outputs — report those upstream.

## Supported versions

The 0.x series is beta; only the **latest release** receives fixes. Update with
`/plugin marketplace update agent-router-cc` and `claude plugin update
router@agent-router-cc`.
