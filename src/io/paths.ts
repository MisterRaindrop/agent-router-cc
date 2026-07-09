import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROUTER_DIR } from '../domain/constants.ts';

// All layout knowledge for a target project's `.router/` tree lives here.
// Returns absolute paths; run-NNN formatting is centralized in runId().

export interface RouterPaths {
  readonly root: string; // absolute path to the .router dir
  readonly repoRoot: string; // the git repo root (parent of .router)
  readonly policy: string;
  readonly registry: string;
  readonly metrics: string;
  readonly lockDir: string;
  readonly contextDir: string;
  readonly tasksDir: string;
  readonly worktreesDir: string;
  taskDir(id: string): string;
  taskYaml(id: string): string;
  contractMd(id: string): string;
  planMd(id: string): string;
  stateFile(id: string): string;
  eventsFile(id: string): string;
  taskContextDir(id: string): string;
  runsDir(id: string): string;
  runDir(id: string, runId: string): string;
  lease(id: string, runId: string): string;
  heartbeat(id: string, runId: string): string;
  resultJson(id: string, runId: string): string;
  diffPatch(id: string, runId: string): string;
  workerLog(id: string, runId: string): string;
  worktree(id: string, runId: string): string;
}

/** Zero-padded run id, e.g. runId(1) === "run-001". */
export function runId(n: number): string {
  return `run-${String(n).padStart(3, '0')}`;
}

/** Branch name for a run, e.g. "router/<id>/run-001". */
export function runBranch(id: string, run: string): string {
  return `router/${id}/${run}`;
}

export function routerPaths(routerDir: string): RouterPaths {
  const root = resolve(routerDir);
  const tasksDir = join(root, 'tasks');
  const taskDir = (id: string) => join(tasksDir, id);
  const runDir = (id: string, run: string) => join(taskDir(id), 'runs', run);
  return {
    root,
    repoRoot: dirname(root),
    policy: join(root, 'policy.yaml'),
    registry: join(root, 'registry.json'),
    metrics: join(root, 'metrics.jsonl'),
    lockDir: join(root, '.lock'),
    contextDir: join(root, 'context'),
    tasksDir,
    worktreesDir: join(root, 'worktrees'),
    taskDir,
    taskYaml: (id) => join(taskDir(id), 'task.yaml'),
    contractMd: (id) => join(taskDir(id), 'TASK_CONTRACT.md'),
    planMd: (id) => join(taskDir(id), 'PLAN.md'),
    stateFile: (id) => join(taskDir(id), 'state.json'),
    eventsFile: (id) => join(taskDir(id), 'events.jsonl'),
    taskContextDir: (id) => join(taskDir(id), 'context'),
    runsDir: (id) => join(taskDir(id), 'runs'),
    runDir,
    lease: (id, run) => join(runDir(id, run), 'lease.json'),
    heartbeat: (id, run) => join(runDir(id, run), 'heartbeat'),
    resultJson: (id, run) => join(runDir(id, run), 'result.json'),
    diffPatch: (id, run) => join(runDir(id, run), 'diff.patch'),
    workerLog: (id, run) => join(runDir(id, run), 'logs', 'worker.log'),
    worktree: (id, run) => join(root, 'worktrees', id, run),
  };
}

/**
 * Walk up from `startDir` looking for an existing `.router/` directory.
 * Returns its absolute path, or null if none is found up to the filesystem root.
 */
export function findRouterDir(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ROUTER_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
