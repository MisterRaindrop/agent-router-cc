// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Shared by the executor fakes: commit the files this "executor" just wrote.
//
// The fakes have to do this because the real contract does. Dispatch no longer sweeps the
// working tree into a commit of its own -- the executor commits one functional unit at a time,
// and the closing invariant fails the run over anything left behind. A fake that only wrote
// files would therefore reproduce a forgotten-file failure, not a successful run.
//
// Named paths rather than `add -A` for the same reason a real executor is told to: staging
// everything in the user's own checkout would also stage whatever else happens to be sitting
// there, router's own `.router/` bookkeeping included.
import { execFileSync } from 'node:child_process';

export function commitUnit(message, paths) {
  execFileSync('git', ['add', '--', ...paths], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.name=fake-executor', '-c', 'user.email=fake@localhost', 'commit', '-q', '-m', message],
    { stdio: 'ignore' },
  );
}
