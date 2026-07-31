// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { GateConfig, GateMode } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';

const KEYS = new Set([
  'mode',
  'integration_branch',
  'gate',
  'clean_gate',
  'clean_triggers',
  'reset',
  'lock_wait_minutes',
  'env',
  'gate_wall_minutes',
]);

/** Absolute path to the optional per-repo gate configuration. */
export function gateYamlPath(paths: RouterPaths): string {
  return join(paths.root, 'gate.yaml');
}

function invalid(problem: string): never {
  throw new Error(`invalid gate.yaml: ${problem}`);
}

function commandList(value: unknown, key: string): string[][] {
  if (!Array.isArray(value)) invalid(`${key} must be an array of argv arrays`);
  return value.map((command, commandIndex) => {
    if (!Array.isArray(command) || command.length === 0) {
      invalid(`${key}[${commandIndex}] must be a non-empty argv array`);
    }
    return command.map((arg, argIndex) => {
      if (typeof arg !== 'string' || arg.length === 0) {
        invalid(`${key}[${commandIndex}][${argIndex}] must be a non-empty string`);
      }
      return arg;
    });
  });
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) invalid(`${key} must be an array of non-empty strings`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      invalid(`${key}[${index}] must be a non-empty string`);
    }
    return item;
  });
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Load `.router/gate.yaml`.
 *
 * Unlike loadModelConfig, this must never turn an unreadable or malformed file
 * into a default: guessing the gate mode could report a verification from an
 * environment in which the real gate cannot run.
 */
export function loadGateConfig(paths: RouterPaths): GateConfig {
  const path = gateYamlPath(paths);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        lstatSync(path);
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'worktree' };
      }
    }
    throw new Error(`gate.yaml is unreadable at ${path}: ${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = load(text, { schema: JSON_SCHEMA });
  } catch (err) {
    throw new Error(`gate.yaml parse error: ${(err as Error).message}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('top level must be a mapping');
  }
  const object = raw as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!KEYS.has(key)) invalid(`unknown top-level key "${key}"`);
  }

  const modeValue = object.mode;
  if (modeValue !== 'worktree' && modeValue !== 'queue') {
    invalid('mode must be "worktree" or "queue"');
  }
  const mode: GateMode = modeValue;
  const config: GateConfig = { mode };

  if (own(object, 'integration_branch')) {
    if (typeof object.integration_branch !== 'string' || object.integration_branch.length === 0) {
      invalid('integration_branch must be a non-empty string');
    }
    config.integration_branch = object.integration_branch;
  }
  if (own(object, 'gate')) config.gate = commandList(object.gate, 'gate');
  if (own(object, 'clean_gate')) {
    config.clean_gate = commandList(object.clean_gate, 'clean_gate');
  }
  if (own(object, 'clean_triggers')) {
    config.clean_triggers = stringList(object.clean_triggers, 'clean_triggers');
  }
  if (own(object, 'reset')) config.reset = commandList(object.reset, 'reset');
  if (own(object, 'lock_wait_minutes')) {
    const value = object.lock_wait_minutes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      invalid('lock_wait_minutes must be a non-negative finite number');
    }
    config.lock_wait_minutes = value;
  }
  if (own(object, 'env')) config.env = stringList(object.env, 'env');
  if (own(object, 'gate_wall_minutes')) {
    const value = object.gate_wall_minutes;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      invalid('gate_wall_minutes must be a positive finite number');
    }
    config.gate_wall_minutes = value;
  }

  if (mode === 'queue') {
    if (config.integration_branch === undefined) {
      invalid('integration_branch is required when mode is "queue"');
    }
    if (config.gate === undefined) invalid('gate is required when mode is "queue"');
    if (config.gate.length === 0) invalid('gate must contain at least one argv array in queue mode');
  }
  return config;
}
