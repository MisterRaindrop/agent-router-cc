// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

// Injectable clock. core/ never reads time; the app passes a Clock into any io
// that needs a timestamp, so tests can freeze/advance time deterministically.
export interface Clock {
  /** Wall-clock ISO-8601, e.g. for event timestamps. */
  nowIso(): string;
  /** Monotonic milliseconds for durations/timeouts (not affected by clock jumps). */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

/** A frozen/advanceable clock for tests. */
export function fixedClock(startIso: string, startMonoMs = 0): Clock & {
  set(iso: string): void;
  advanceMs(ms: number): void;
} {
  let iso = startIso;
  let mono = startMonoMs;
  return {
    nowIso: () => iso,
    monotonicMs: () => mono,
    set: (v: string) => {
      iso = v;
    },
    advanceMs: (ms: number) => {
      mono += ms;
    },
  };
}
