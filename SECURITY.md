# Security Policy

router executes model-written code in sandboxed worktrees, scans diffs for secrets, and
deliberately withholds credentials from executors. Bugs in any of those areas are
security bugs, and we want to hear about them.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via
[GitHub Security Advisories](https://github.com/MisterRaindrop/agent-router-cc/security/advisories/new)
("Report a vulnerability"). You should receive a response within a few days.

Please include:

- What the vulnerability lets an attacker (or a malicious/compromised executor) do.
- Reproduction steps or a proof of concept.
- The router version (`.claude-plugin/plugin.json`) and platform.

## Scope — what counts

Especially interesting:

- **Sandbox escapes:** an executor writing outside its worktree, reaching the parent
  environment, or acquiring `Bash` beyond the granted verify command.
- **Credential leakage:** executor processes receiving environment variables beyond the
  documented login-session context and explicitly configured provider key.
- **Gate bypasses:** a diff that clears `scope` / `secret_scan` / `exec_bit` while
  violating what they promise (e.g. secrets that evade the scanner, writes outside
  `allowed_globs` that pass the scope check).
- **Queue-gate safety:** `router gate` modifying tracked content it promised not to
  touch, or failing to restore the original ref.
- Anything that makes `land` change your working tree beyond the verified diff.

Out of scope: vulnerabilities in the executor CLIs themselves (codex, claude), in
Claude Code, or in the models' outputs — report those upstream.

## Supported versions

The 0.x series is beta; only the **latest release** receives fixes. Update with
`/plugin marketplace update agent-router-cc` and `claude plugin update
router@agent-router-cc`.
