import { readFileSync } from 'node:fs';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { TaskYaml } from '../domain/types.ts';
import { validateTaskYaml } from '../domain/validate.ts';
import type { RouterPaths } from '../io/paths.ts';

export class TaskContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskContractError';
  }
}

export interface LoadedTask {
  task: TaskYaml;
  taskYamlText: string;
  contractMdText: string;
}

/** Read and validate the frozen task.yaml + TASK_CONTRACT.md from .router/tasks/<id>/. */
export function loadTask(paths: RouterPaths, id: string): LoadedTask {
  const taskYamlText = readFileSync(paths.taskYaml(id), 'utf8');
  let contractMdText = '';
  try {
    contractMdText = readFileSync(paths.contractMd(id), 'utf8');
  } catch {
    contractMdText = '';
  }
  let data: unknown;
  try {
    data = load(taskYamlText, { schema: JSON_SCHEMA });
  } catch (err) {
    throw new TaskContractError(`task.yaml parse error: ${(err as Error).message}`);
  }
  const r = validateTaskYaml(data);
  if (!r.ok || r.value === null) {
    throw new TaskContractError(`invalid task.yaml: ${r.errors.join('; ')}`);
  }
  return { task: r.value, taskYamlText, contractMdText };
}
