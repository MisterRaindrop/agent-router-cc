// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

// Contract freeze hash (design D1). Byte-exact over an LF-normalized, canonical
// concatenation of the machine contract (task.yaml) and the prose contract
// (TASK_CONTRACT.md). Recorded at VALIDATED; verifier check 5 recomputes it to
// prove the frozen contract wasn't edited after validation. PURE.

function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function hashContract(taskYamlText: string, contractMdText: string): string {
  const payload =
    `router-contract-v1\n` +
    `--- task.yaml ---\n${normalizeLF(taskYamlText)}\n` +
    `--- TASK_CONTRACT.md ---\n${normalizeLF(contractMdText)}\n`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
