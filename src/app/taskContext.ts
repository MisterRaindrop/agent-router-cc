// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { TaskYaml } from '../domain/types.ts';
import type { RouterPaths } from '../io/paths.ts';

export interface TaskContext {
  text: string;
  base_sha: string;
  plan_revision?: string;
  chars: number;
  sha256: string;
}

export const TASK_CONTEXT_SOFT_LIMIT = 8000;

function contextError(taskId: string, message: string): Error {
  return new Error(`TASK_CONTEXT.md for task ${taskId}: ${message}`);
}

/**
 * Load an optional navigation summary and validate the identity fields that bind it to
 * the task. The whole file is retained verbatim for injection and measurement.
 */
export function loadTaskContext(paths: RouterPaths, task: TaskYaml): TaskContext | null {
  const path = paths.taskContext(task.id);
  if (!existsSync(path)) return null;

  const text = readFileSync(path, 'utf8');
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (frontmatter === null) {
    throw contextError(task.id, 'missing YAML frontmatter (expected a leading --- fenced block)');
  }

  let parsed: unknown;
  try {
    parsed = load(frontmatter[1]!, { schema: JSON_SCHEMA });
  } catch (err) {
    throw contextError(task.id, `frontmatter parse error: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw contextError(task.id, 'frontmatter must be a YAML mapping');
  }
  const metadata = parsed as Record<string, unknown>;

  for (const key of ['task_id', 'base_sha'] as const) {
    if (!Object.prototype.hasOwnProperty.call(metadata, key)) {
      throw contextError(task.id, `missing required frontmatter key "${key}"`);
    }
    if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
      throw contextError(task.id, `frontmatter key "${key}" must be a non-empty string`);
    }
  }

  const contextTaskId = metadata.task_id as string;
  const baseSha = metadata.base_sha as string;
  if (contextTaskId !== task.id) {
    throw contextError(task.id, `task_id mismatch: expected "${task.id}", got "${contextTaskId}"`);
  }

  let planRevision: string | undefined;
  if (Object.prototype.hasOwnProperty.call(metadata, 'plan_revision')) {
    if (typeof metadata.plan_revision !== 'string' || metadata.plan_revision.length === 0) {
      throw contextError(task.id, 'frontmatter key "plan_revision" must be a non-empty string when present');
    }
    planRevision = metadata.plan_revision;
    if (task.plan_revision !== undefined && planRevision !== task.plan_revision) {
      throw contextError(
        task.id,
        `plan_revision mismatch: task declares "${task.plan_revision}", context declares "${planRevision}"`,
      );
    }
  }

  return {
    text,
    base_sha: baseSha,
    ...(planRevision !== undefined ? { plan_revision: planRevision } : {}),
    chars: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}
