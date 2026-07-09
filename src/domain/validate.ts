import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import type { Policy, TaskYaml } from './types.ts';
import policySchema from '../../schema/policy.schema.json' with { type: 'json' };
import taskSchema from '../../schema/task_contract.schema.json' with { type: 'json' };

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true });
const validatePolicyFn = ajv.compile(policySchema);
const validateTaskFn = ajv.compile(taskSchema);

function fmt(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const where = e.instancePath === '' ? '(root)' : e.instancePath;
    return `${where} ${e.message ?? 'invalid'}`.trim();
  });
}

export function validatePolicy(data: unknown): ValidationResult<Policy> {
  const ok = validatePolicyFn(data) as boolean;
  return ok
    ? { ok: true, value: data as Policy, errors: [] }
    : { ok: false, value: null, errors: fmt(validatePolicyFn.errors) };
}

export function validateTaskYaml(data: unknown): ValidationResult<TaskYaml> {
  const ok = validateTaskFn(data) as boolean;
  return ok
    ? { ok: true, value: data as TaskYaml, errors: [] }
    : { ok: false, value: null, errors: fmt(validateTaskFn.errors) };
}
