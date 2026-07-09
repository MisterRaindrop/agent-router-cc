// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { Registry, RegistryEntry } from '../domain/types.ts';
import { withGlobalLock } from '../io/lock.ts';
import * as store from '../io/store.ts';
import { foldEvents } from '../core/projectState.ts';
import type { TransitionDeps } from './transition.ts';

// registry.json and state.json are rebuildable projections of events.jsonl.
// reindex re-derives both from the event logs - so a corrupt or deleted
// registry is never fatal.

export interface ReindexResult {
  registry: Registry;
  errors: { id: string; error: string }[];
}

export function rebuildRegistry(deps: TransitionDeps): ReindexResult {
  const { paths, clock } = deps;
  return withGlobalLock(paths.lockDir, () => {
    const tasks: Record<string, RegistryEntry> = {};
    const errors: { id: string; error: string }[] = [];
    for (const id of store.listTaskIds(paths)) {
      const events = store.readEvents(paths, id);
      if (events.length === 0) continue;
      try {
        const st = foldEvents(id, events);
        store.writeState(paths, id, st); // repair any state.json drift
        tasks[id] = {
          state: st.state,
          current_run: st.current_run,
          title: st.title,
          updated_at: st.updated_at,
        };
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const registry: Registry = { schema_version: 1, rebuilt_at: clock.nowIso(), tasks };
    store.writeRegistry(paths, registry);
    return { registry, errors };
  });
}
