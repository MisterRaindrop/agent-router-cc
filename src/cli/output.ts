// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Output helpers. Every verb supports --json (stable machine output); otherwise
// a compact human line is printed.

export function out(s: string): void {
  process.stdout.write(`${s}\n`);
}
export function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

export function emit(json: boolean, value: unknown, human: () => string): void {
  if (json) out(JSON.stringify(value));
  else out(human());
}

export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}
