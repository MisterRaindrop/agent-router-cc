#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { commitUnit } from '../../testkit/fakeCommit.mjs';

const argv = process.argv.slice(2);
const isResume = argv[0] === 'exec' && argv[1] === 'resume';
// From the prompt, not from the cwd. The cwd used to be `.router/worktrees/<id>/run-001`, so its
// parent directory happened to be the task id; the cwd is the shared repository root now.
// A resume carries no prompt at all -- only the session id and the feedback -- so there the id
// comes back out of the session id this same fake minted on the first run.
const prompt = argv.find((arg) => /^task: \S+$/m.test(arg)) ?? '';
const id = isResume
  ? (argv[2] ?? '').replace(/^fake-session-/, '')
  : /^task: (\S+)$/m.exec(prompt)?.[1];
if (id === undefined || id === '') {
  process.stderr.write('fakeCodexDelivery could not work out its task id\n');
  process.exit(9);
}
const sessionId = isResume ? (argv[2] ?? `fake-session-${id}`) : `fake-session-${id}`;
writeFileSync('src/a.ts', `export const x = ${isResume ? 3 : 2}; // delivery fake for ${id}\n`);
// Not committed on the conflict path: an executor reporting CONTRACT_CONFLICT is told to undo
// its experiment, so leaving the edit uncommitted is the faithful simulation.
if (!id.startsWith('contract-conflict')) commitUnit(`fake: unit for ${id}`, ['src/a.ts']);

let finalMessage = `${isResume ? 'Resumed delivery' : 'Delivery report'} for ${id}.`;
if (id.startsWith('contract-conflict')) {
  finalMessage = `

CONTRACT_CONFLICT:
The implementation contradicts the frozen contract. Revise the plan.`;
} else if (id === 'delivery-valid') {
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
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'inspect contract' } }) + '\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: finalMessage } }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 70 },
  }) + '\n',
);
