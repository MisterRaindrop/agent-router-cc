// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Not a test file (the runner globs `*.test.ts`): the shared child environment for every test
// that spawns the router CLI.
//
// `depsFor()` refuses to run when ROUTER_EXECUTOR_SANDBOX is set -- that sentinel is how an
// executor is stopped from driving router itself. Tests inherit the ambient environment, so a
// suite run from inside an executor's shell had ~60 tests fail with rc=2, and the executor's
// only way forward was to unset the variable by hand. That is precisely the "make the
// environment cooperate" move the flow forbids, so the tests must be hermetic instead of the
// humans careful.
//
// Router's own gate was never affected: it builds the worker environment with buildWorkerEnv,
// which does not carry the sentinel.
// Only the INHERITED sentinel is dropped. A test that deliberately sets it -- to prove the
// executor guard still refuses -- passes it in `extra`, and that must survive: stripping it there
// would silently disable the very test that proves the guard works. (Measured: doing it the other
// way round broke `an executor cannot touch real router state (8h)`.)
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  delete inherited.ROUTER_EXECUTOR_SANDBOX;
  return { ...inherited, ...extra };
}
