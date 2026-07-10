#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Stand-in codex that hits a quota/rate limit: prints a rate-limit line and exits
// nonzero. The router reclassifies this task_failed -> quota_exhausted and falls
// through to the next executor. Makes no edits.
process.stdout.write('Error: 429 rate limit exceeded — usage limit reached\n');
process.exit(1);
