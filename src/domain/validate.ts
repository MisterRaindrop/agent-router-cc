// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import type { TaskYaml } from './types.ts';
import taskSchema from '../../schema/task_contract.schema.json' with { type: 'json' };

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true });
const validateTaskFn = ajv.compile(taskSchema);

function fmt(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const where = e.instancePath === '' ? '(root)' : e.instancePath;
    return `${where} ${e.message ?? 'invalid'}`.trim();
  });
}

export function validateTaskYaml(data: unknown): ValidationResult<TaskYaml> {
  const ok = validateTaskFn(data) as boolean;
  return ok
    ? { ok: true, value: data as TaskYaml, errors: [] }
    : { ok: false, value: null, errors: fmt(validateTaskFn.errors) };
}
