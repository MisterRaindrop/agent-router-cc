// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { runCli } from './cli/main.ts';

process.exitCode = await runCli(process.argv.slice(2));
