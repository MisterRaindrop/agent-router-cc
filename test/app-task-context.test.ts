// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskYaml } from '../src/domain/types.ts';
import { loadTaskContext } from '../src/app/taskContext.ts';
import { routerPaths } from '../src/io/paths.ts';

const TASK: TaskYaml = {
  schema_version: 1,
  id: 't1',
  title: 'demo',
  base_sha: null,
  plan_revision: 'rev-1',
  max_wall_minutes: 1,
  allowed_globs: ['src/**'],
};

function fixture(): {
  dir: string;
  paths: ReturnType<typeof routerPaths>;
  write(text: string): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'router-task-context-'));
  const paths = routerPaths(join(dir, '.router'));
  mkdirSync(paths.taskDir(TASK.id), { recursive: true });
  return {
    dir,
    paths,
    write: (text) => writeFileSync(paths.taskContext(TASK.id), text),
  };
}

test('loadTaskContext returns null when the optional file is absent', () => {
  const fx = fixture();
  try {
    assert.equal(loadTaskContext(fx.paths, TASK), null);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('loadTaskContext retains and measures the whole valid file', () => {
  const fx = fixture();
  const text = `---
task_id: t1
base_sha: abc123
plan_id: plan-1
plan_revision: rev-1
generated_at: 2026-07-31T00:00:00Z
source: orchestrator
---
# Navigation
Read src/a.ts.
`;
  try {
    fx.write(text);
    assert.deepEqual(loadTaskContext(fx.paths, TASK), {
      text,
      base_sha: 'abc123',
      plan_revision: 'rev-1',
      chars: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('loadTaskContext rejects every untrusted frontmatter form with a precise reason', () => {
  const cases = [
    {
      name: 'missing frontmatter',
      text: '# Navigation only\n',
      expected: /missing YAML frontmatter/,
    },
    {
      name: 'unparseable frontmatter',
      text: '---\ntask_id: [\n---\nbody\n',
      expected: /frontmatter parse error/,
    },
    {
      name: 'missing required key',
      text: '---\ntask_id: t1\n---\nbody\n',
      expected: /missing required frontmatter key "base_sha"/,
    },
    {
      name: 'task id mismatch',
      text: '---\ntask_id: other\nbase_sha: abc123\n---\nbody\n',
      expected: /task_id mismatch: expected "t1", got "other"/,
    },
    {
      name: 'plan revision mismatch',
      text: '---\ntask_id: t1\nbase_sha: abc123\nplan_revision: rev-2\n---\nbody\n',
      expected: /plan_revision mismatch: task declares "rev-1", context declares "rev-2"/,
    },
  ];

  for (const c of cases) {
    const fx = fixture();
    try {
      fx.write(c.text);
      assert.throws(() => loadTaskContext(fx.paths, TASK), c.expected, c.name);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  }
});
