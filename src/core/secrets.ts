// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Diff secret scanning. PURE: operates on the raw unified-diff text and returns
// findings. It inspects only ADDED lines (a line beginning with a single '+',
// not the '+++' file header) - we care about secrets being INTRODUCED, and this
// keeps context/removed lines from tripping the scan. The built-in pattern set
// is deliberately conservative to limit false positives; policy may opt out or
// extend it (see SecretScanPolicy).

export interface SecretFinding {
  rule: string; // which pattern matched
  line: number; // 1-based line number within the diff text
  snippet: string; // short, redacted excerpt for the report
}

// AWS access key ids have a fixed, distinctive shape.
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
// PEM private-key headers - unambiguous, near-zero false positives.
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
// A secret-ish name assigned a quoted literal. The value is entropy-gated below
// so ordinary prose (e.g. token = "the quick brown fox ...") is not flagged.
const SECRET_ASSIGNMENT =
  /(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|token)["']?\s*[:=]\s*["']([^"']{20,})["']/i;

// Entropy proxy: long AND mixes letters with digits. Conservative on purpose.
function looksLikeSecret(value: string): boolean {
  return value.length >= 20 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function redact(content: string): string {
  const t = content.trim();
  return t.length <= 16 ? t : `${t.slice(0, 12)}...(${t.length} chars)`;
}

/**
 * Scan a unified diff for likely secrets in added lines. `extraPatterns` are
 * user-supplied regex sources (from policy) matched against the same added
 * content. Returns every finding (empty array => clean). PURE.
 */
export function scanSecrets(
  diffText: string,
  extraPatterns: readonly string[] = [],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const extra = extraPatterns.map((p) => new RegExp(p));
  const lines = diffText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only added content lines: a leading '+' but not the '+++ b/path' header.
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);

    if (AWS_ACCESS_KEY.test(content)) {
      findings.push({ rule: 'aws_access_key', line: i + 1, snippet: redact(content) });
    }
    if (PRIVATE_KEY_HEADER.test(content)) {
      findings.push({ rule: 'private_key_header', line: i + 1, snippet: redact(content) });
    }
    const m = SECRET_ASSIGNMENT.exec(content);
    if (m !== null && looksLikeSecret(m[1]!)) {
      findings.push({ rule: 'secret_assignment', line: i + 1, snippet: redact(content) });
    }
    for (let k = 0; k < extra.length; k++) {
      if (extra[k]!.test(content)) {
        findings.push({ rule: `custom_pattern[${k}]`, line: i + 1, snippet: redact(content) });
      }
    }
  }
  return findings;
}
