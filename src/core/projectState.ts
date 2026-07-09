import type { EventRecord, StateFile, TaskState } from '../domain/types.ts';
import { canTransition } from './stateMachine.ts';

// Rebuild the authoritative task state by folding the append-only event log.
// events.jsonl is the source of truth; state.json / registry.json are just
// projections of this function. PURE: no fs, no clock.
//
// Folding also VERIFIES the log's integrity — a hand-edited events.jsonl with a
// seq gap, a wrong `from`, or an illegal transition is rejected here. That is
// how tampering with state is detected.

export class CorruptEventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptEventLogError';
  }
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key];
  return typeof v === 'string' ? v : undefined;
}
function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = meta?.[key];
  return typeof v === 'number' ? v : undefined;
}

export function foldEvents(id: string, events: readonly EventRecord[]): StateFile {
  if (events.length === 0) {
    throw new CorruptEventLogError(`no events for task ${id}`);
  }

  let state: TaskState | null = null;
  let baseSha: string | null = null;
  let contractHash: string | null = null;
  let currentRun: string | null = null;
  let attempt = 0;
  let title = '';
  let updatedAt = '';
  let expectedSeq = 1;

  for (const e of events) {
    if (e.seq !== expectedSeq) {
      throw new CorruptEventLogError(
        `task ${id}: event seq gap — expected ${expectedSeq}, got ${e.seq}`,
      );
    }
    expectedSeq += 1;

    if (state === null) {
      if (e.from !== null || e.to !== 'DRAFT') {
        throw new CorruptEventLogError(
          `task ${id}: first event must be (null -> DRAFT), got (${e.from} -> ${e.to})`,
        );
      }
    } else {
      if (e.from !== state) {
        throw new CorruptEventLogError(
          `task ${id}: event.from ${e.from} != current state ${state} at seq ${e.seq}`,
        );
      }
      if (!canTransition(state, e.to)) {
        throw new CorruptEventLogError(
          `task ${id}: illegal transition ${state} -> ${e.to} at seq ${e.seq}`,
        );
      }
    }

    state = e.to;
    updatedAt = e.ts;

    const title2 = metaString(e.meta, 'title');
    if (title2 !== undefined) title = title2;
    const base = metaString(e.meta, 'base_sha');
    if (base !== undefined) baseSha = base;
    const hash = metaString(e.meta, 'contract_hash');
    if (hash !== undefined) contractHash = hash;

    if (e.to === 'RUNNING') {
      const n = metaNumber(e.meta, 'attempt_number');
      attempt = n !== undefined ? n : attempt + 1;
    }
    if (e.run_id !== null) currentRun = e.run_id;
  }

  const last = events[events.length - 1]!;
  return {
    schema_version: 1,
    id,
    state: state as TaskState,
    base_sha: baseSha,
    contract_hash: contractHash,
    current_run: currentRun,
    attempt_number: attempt,
    title,
    updated_at: updatedAt,
    last_event_seq: last.seq,
  };
}
