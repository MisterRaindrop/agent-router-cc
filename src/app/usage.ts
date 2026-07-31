// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Parse token usage and model from a codex `exec --json` event stream (captured
// in the worker log). codex emits one `turn.completed` event per turn carrying a
// `usage` object; we sum across turns. Cost, when present, is the provider-reported
// value (claude's `total_cost_usd`); a ChatGPT-plan run reports none.

import type { DeliveryHeader } from '../domain/types.ts';

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export interface ParsedLog {
  usage: Usage | null;
  model: string | null;
  costUsd?: number | null; // provider-reported cost (claude), if any; else derived from price
  // The executor's own session/thread id, read from its JSON stream. Stored on the
  // run so a later resume can re-attach to the SAME session; comparing the resumed
  // run's reported id back to this one proves the resume attached (see `router resume`).
  sessionId?: string | null;
  finalMessage?: string | null;
  commandsRun?: number;
}

/** Single pass over the log: token usage (summed) and model slug (if the stream reports one). */
export function parseCodexLog(logText: string): ParsedLog {
  let found = false;
  let input = 0;
  let output = 0;
  let cached = 0;
  let model: string | null = null;
  let sessionId: string | null = null;
  let finalMessage: string | undefined;
  let commandsRun = 0;
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as {
      type?: string;
      usage?: Record<string, unknown>;
      model?: unknown;
      thread?: { model?: unknown; id?: unknown };
      turn?: { model?: unknown };
      session_id?: unknown;
      thread_id?: unknown;
      session?: { id?: unknown };
      item?: { type?: unknown; text?: unknown };
    };
    if (rec.type === 'turn.completed' && rec.usage) {
      found = true;
      input += num(rec.usage.input_tokens);
      output += num(rec.usage.output_tokens);
      cached += num(rec.usage.cached_input_tokens);
    }
    if (model === null) {
      const m = rec.model ?? rec.thread?.model ?? rec.turn?.model;
      if (typeof m === 'string' && m !== '') model = m;
    }
    if (sessionId === null) {
      const s = rec.session_id ?? rec.thread_id ?? rec.thread?.id ?? rec.session?.id;
      if (typeof s === 'string' && s !== '') sessionId = s;
    }
    if (rec.type === 'item.completed' && rec.item?.type === 'agent_message' && typeof rec.item.text === 'string') {
      finalMessage = rec.item.text;
    }
    if (rec.type === 'item.completed' && rec.item?.type === 'command_execution') commandsRun += 1;
  }
  return {
    usage: found ? { input, output, cached } : null,
    model,
    sessionId,
    commandsRun,
    ...(finalMessage !== undefined ? { finalMessage } : {}),
  };
}

/**
 * Parse the claude CLI `--output-format stream-json` stream: the final
 * `type:"result"` event carries `usage` (input/output tokens) and
 * `total_cost_usd` (an API-equivalent cost, present even on a plan).
 */
export function parseClaudeLog(logText: string): ParsedLog {
  let usage: Usage | null = null;
  let costUsd: number | null = null;
  let model: string | null = null;
  let sessionId: string | null = null;
  let finalMessage: string | undefined;
  for (const line of logText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as {
      type?: string;
      usage?: Record<string, unknown>;
      total_cost_usd?: unknown;
      model?: unknown;
      session_id?: unknown;
      result?: unknown;
      message?: { content?: unknown };
    };
    if (rec.type === 'result' && rec.usage) {
      // `input` must mean the SAME thing for both executors, because usage compares them and
      // derives savings from it. Codex already reports an inclusive `input_tokens` with
      // `cached_input_tokens` as its subset (observed: 1,080,432 total of which 993,536 cached).
      // Claude splits input three ways instead, so total input is the sum -- reading only
      // `input_tokens` reported 9 for a run that had just read a repository, which silently
      // understates every token-derived saving for a claude executor. `cached` stays the read
      // subset. (`deriveCost` still applies one input rate to the total, so its number remains
      // approximate for cached and cache-writing runs; the provider-reported cost is preferred
      // wherever it exists.)
      usage = {
        input:
          num(rec.usage.input_tokens) +
          num(rec.usage.cache_read_input_tokens) +
          num(rec.usage.cache_creation_input_tokens),
        output: num(rec.usage.output_tokens),
        cached: num(rec.usage.cache_read_input_tokens),
      };
      if (typeof rec.total_cost_usd === 'number') costUsd = rec.total_cost_usd;
    }
    if (model === null && typeof rec.model === 'string' && rec.model !== '') model = rec.model;
    // claude emits session_id on the init `system` event and again on `result`.
    if (sessionId === null && typeof rec.session_id === 'string' && rec.session_id !== '') sessionId = rec.session_id;
    if (rec.type === 'assistant') {
      const text = claudeAssistantText(rec.message?.content);
      if (text !== null) finalMessage = text;
    }
    // The terminal result event repeats the final assistant text verbatim.
    if (rec.type === 'result' && typeof rec.result === 'string') finalMessage = rec.result;
  }
  return {
    usage,
    model,
    costUsd,
    sessionId,
    ...(finalMessage !== undefined ? { finalMessage } : {}),
  };
}

/**
 * Parse the last fenced router-delivery header in an executor's final message.
 * Any missing required field or uncertain boolean fails closed.
 */
export function parseDeliveryHeader(finalMessage: string | null | undefined): DeliveryHeader | null {
  if (finalMessage == null) return null;
  const blockPattern = /```router-delivery[ \t]*\r?\n([\s\S]*?)```/g;
  let body: string | null = null;
  for (const match of finalMessage.matchAll(blockPattern)) body = match[1] ?? '';
  if (body === null) return null;

  const values = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const task = values.get('task');
  const gateRan = deliveryBoolean(values.get('gate_ran'));
  const scopeDrift = deliveryBoolean(values.get('scope_drift'));
  const escalateReview = deliveryBoolean(values.get('escalate_review'));
  if (!task || gateRan === null || scopeDrift === null || escalateReview === null) return null;

  const planRevision = values.get('plan_revision');
  return {
    task,
    ...(planRevision !== undefined ? { plan_revision: planRevision } : {}),
    gate_ran: gateRan,
    scope_drift: scopeDrift,
    escalate_review: escalateReview,
  };
}

function claudeAssistantText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') text.push(block);
    else if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      text.push((block as { text: string }).text);
    }
  }
  return text.length > 0 ? text.join('') : null;
}

function deliveryBoolean(value: string | undefined): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
