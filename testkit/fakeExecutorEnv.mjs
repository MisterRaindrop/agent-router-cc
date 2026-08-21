#!/usr/bin/env node
// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { commitUnit } from './fakeCommit.mjs';

if (process.env.ROUTER_TEST_API_KEY !== 'executor-secret') process.exit(9);
writeFileSync('src/a.ts', 'export const x = 2; // executor received its explicit key\n');
commitUnit('fake: unit a', ['src/a.ts']);
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
