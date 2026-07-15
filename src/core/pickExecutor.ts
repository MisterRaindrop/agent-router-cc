// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { ExecutorQuota, WorkerKind } from '../domain/types.ts';

// Balance the two cheap executors by REAL remaining quota (PURE). Route the next
// task to the executor with the most headroom (lowest used_percent); ties break to
// the one whose window resets soonest. Executors that hit a hard limit are skipped;
// null means every candidate is exhausted (caller waits / reports).
export function pickExecutor(quotas: readonly ExecutorQuota[]): WorkerKind | null {
  const available = quotas.filter((q) => q.available);
  if (available.length === 0) return null;
  let best = available[0]!;
  for (const q of available.slice(1)) {
    if (q.used_percent < best.used_percent) best = q;
    else if (q.used_percent === best.used_percent) {
      const qr = q.resets_at ?? Infinity;
      const br = best.resets_at ?? Infinity;
      if (qr < br) best = q;
    }
  }
  return best.kind;
}
