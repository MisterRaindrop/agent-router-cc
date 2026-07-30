// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface MainModelUsage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

const emptyUsage = (): MainModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
});

function addLineUsage(
  line: string,
  sinceIso: string,
  model: string,
  untilIso: string | undefined,
  total: MainModelUsage,
): void {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }

  if (record === null || typeof record !== 'object') return;
  const entry = record as Record<string, unknown>;
  if (entry['type'] !== 'assistant') return;
  if (typeof entry['timestamp'] !== 'string' || entry['timestamp'] < sinceIso) return;
  if (untilIso !== undefined && entry['timestamp'] > untilIso) return;

  const message = entry['message'];
  if (message === null || typeof message !== 'object') return;
  const assistantMessage = message as Record<string, unknown>;
  if (typeof assistantMessage['model'] !== 'string' || !assistantMessage['model'].includes(model)) return;

  const usage = assistantMessage['usage'];
  if (usage === null || typeof usage !== 'object') return;
  const tokenUsage = usage as Record<string, unknown>;

  total.inputTokens += typeof tokenUsage['input_tokens'] === 'number' ? tokenUsage['input_tokens'] : 0;
  total.outputTokens += typeof tokenUsage['output_tokens'] === 'number' ? tokenUsage['output_tokens'] : 0;
  total.turns += 1;
}

/**
 * Sum matching assistant-turn usage without loading the complete transcript.
 * Unreadable files and malformed individual records are treated as no data.
 */
export function sumMainModelUsageSince(
  transcriptPath: string,
  sinceIso: string,
  model: string,
  untilIso?: string,
): MainModelUsage {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return emptyUsage();
  }

  const total = emptyUsage();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let readFailed = false;

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, bytesRead));

      let newlineAt: number;
      while ((newlineAt = pending.indexOf('\n')) !== -1) {
        addLineUsage(pending.slice(0, newlineAt), sinceIso, model, untilIso, total);
        pending = pending.slice(newlineAt + 1);
      }
    }

    pending += decoder.end();
    if (pending !== '') addLineUsage(pending, sinceIso, model, untilIso, total);
  } catch {
    readFailed = true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not make this best-effort reader throw.
    }
  }

  return readFailed ? emptyUsage() : total;
}
