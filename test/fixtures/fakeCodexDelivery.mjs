#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const id = basename(dirname(process.cwd()));
const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
const sessionId = isResume ? (argv[2] ?? `fake-session-${id}`) : `fake-session-${id}`;
writeFileSync('src/a.ts', `export const x = ${isResume ? 3 : 2}; // delivery fake for ${id}\n`);

let finalMessage = `${isResume ? 'Resumed delivery' : 'Delivery report'} for ${id}.`;
if (id === 'delivery-valid') {
  finalMessage += `
\`\`\`router-delivery
task: delivery-valid
gate_ran: true
scope_drift: false
escalate_review: false
\`\`\``;
} else if (id === 'delivery-mismatch') {
  finalMessage += `
\`\`\`router-delivery
task: another-task
gate_ran: true
scope_drift: false
escalate_review: false
\`\`\``;
} else if (id === 'delivery-plan-mismatch') {
  finalMessage += `
\`\`\`router-delivery
task: delivery-plan-mismatch
plan_revision: another-plan
gate_ran: true
scope_drift: false
escalate_review: false
\`\`\``;
}

process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: sessionId }) + '\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: finalMessage } }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
