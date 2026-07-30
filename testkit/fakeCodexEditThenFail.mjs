#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for codex-cli that does real work and THEN fails: it edits a file in its
// worktree, emits a delivery report, and exits non-zero. Router does not commit a run that
// ended badly, so this is the case where the work is still on disk and must be reported as
// recoverable rather than silently dropped.
import { writeFileSync } from 'node:fs';

writeFileSync('src/a.ts', 'export const x = 2; // edited before failing\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', model: 'fake-model-1', thread_id: 'fake-session-1' }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'agent_message',
      text: 'Edited src/a.ts, then hit a wall.\n\n```router-delivery\ntask: t1\ngate_ran: false\nscope_drift: false\nescalate_review: true\n```\n',
    },
  }) + '\n',
);
process.exit(3);
