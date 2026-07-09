import type { EventRecord, RegistryEntry, StateFile, TaskState } from '../domain/types.ts';
import type { Clock } from '../io/clock.ts';
import type { RouterPaths } from '../io/paths.ts';
import { withGlobalLock } from '../io/lock.ts';
import * as store from '../io/store.ts';
import { assertTransition } from '../core/stateMachine.ts';
import { foldEvents } from '../core/projectState.ts';

// The ONE guarded state-mutation primitive. Every state change funnels through
// here, under the global lock: read events → fold (validates integrity) →
// assert the transition is legal → append event → rewrite the state.json and
// registry projections. Idempotency is the caller's concern (verbs skip a
// no-op transition); this primitive is strict.

export interface TransitionDeps {
  paths: RouterPaths;
  clock: Clock;
}

export interface TransitionOpts {
  runId?: string | null;
  meta?: Record<string, unknown>;
  actor: string;
  /**
   * Optional precondition evaluated INSIDE the global lock, after the current
   * state is folded and the transition is asserted legal, but before the event
   * is appended. Throw to abort atomically (no event written). Used to make a
   * check-then-transition (e.g. the concurrency slot) race-free.
   */
  guard?: (paths: RouterPaths) => void;
}

export class NoSuchTaskError extends Error {
  constructor(id: string) {
    super(`no such task: ${id}`);
    this.name = 'NoSuchTaskError';
  }
}

export class TaskExistsError extends Error {
  constructor(id: string, state: TaskState) {
    super(`task ${id} already exists (state ${state})`);
    this.name = 'TaskExistsError';
  }
}

function upsertRegistry(paths: RouterPaths, id: string, st: StateFile): void {
  const registry = store.readRegistry(paths) ?? {
    schema_version: 1 as const,
    rebuilt_at: st.updated_at,
    tasks: {},
  };
  const entry: RegistryEntry = {
    state: st.state,
    current_run: st.current_run,
    title: st.title,
    updated_at: st.updated_at,
  };
  registry.tasks[id] = entry;
  store.writeRegistry(paths, registry);
}

/** Create a task in DRAFT. Idempotent: a re-create of a still-DRAFT task no-ops. */
export function createTask(deps: TransitionDeps, id: string, title: string): StateFile {
  const { paths, clock } = deps;
  return withGlobalLock(paths.lockDir, () => {
    const events = store.readEvents(paths, id);
    if (events.length > 0) {
      const cur = foldEvents(id, events);
      if (cur.state === 'DRAFT') return cur; // idempotent
      throw new TaskExistsError(id, cur.state);
    }
    const ev: EventRecord = {
      seq: 1,
      ts: clock.nowIso(),
      from: null,
      to: 'DRAFT',
      actor: 'cli:new',
      run_id: null,
      meta: { title },
    };
    store.appendEvent(paths, id, ev);
    const st = foldEvents(id, [ev]);
    store.writeState(paths, id, st);
    upsertRegistry(paths, id, st);
    return st;
  });
}

/** Apply a legal transition. Throws on illegal transition or unknown task. */
export function transition(deps: TransitionDeps, id: string, to: TaskState, opts: TransitionOpts): StateFile {
  const { paths, clock } = deps;
  return withGlobalLock(paths.lockDir, () => {
    const events = store.readEvents(paths, id);
    if (events.length === 0) throw new NoSuchTaskError(id);
    const cur = foldEvents(id, events);
    assertTransition(cur.state, to);
    if (opts.guard !== undefined) opts.guard(paths);
    const ev: EventRecord = {
      seq: cur.last_event_seq + 1,
      ts: clock.nowIso(),
      from: cur.state,
      to,
      actor: opts.actor,
      run_id: opts.runId ?? null,
      ...(opts.meta ? { meta: opts.meta } : {}),
    };
    store.appendEvent(paths, id, ev);
    const st = foldEvents(id, [...events, ev]);
    store.writeState(paths, id, st);
    upsertRegistry(paths, id, st);
    return st;
  });
}

/** Read current state without mutating (folds the log, so also integrity-checks it). */
export function currentState(paths: RouterPaths, id: string): StateFile | null {
  const events = store.readEvents(paths, id);
  if (events.length === 0) return null;
  return foldEvents(id, events);
}
