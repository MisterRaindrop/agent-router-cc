// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import type { TaskState } from '../domain/types.ts';

// The complete task lifecycle graph. The full M2 set (escalation ladder,
// NEEDS_REPLAN) lives here from day 1 so those transitions "exist"; M1 only
// drives a subset (DRAFT->VALIDATED->QUEUED->RUNNING->VERIFYING->PASSED->MERGED,
// plus RUNNING/VERIFYING->FAILED, RUNNING->STALE, any->CANCELLED).
//
// This module is PURE: no fs, no clock, no process. It is the structural
// guarantee that the LLM cannot enact an illegal state change.

const TERMINAL: ReadonlySet<TaskState> = new Set(['MERGED', 'CANCELLED', 'ABANDONED']);

// Reachable regardless of current state (except from terminal states).
const ALWAYS: readonly TaskState[] = ['CANCELLED', 'ABANDONED'];

const TABLE: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['QUEUED', 'DRAFT'],
  QUEUED: ['RUNNING'],
  RUNNING: ['VERIFYING', 'STALE', 'FAILED'],
  VERIFYING: ['PASSED', 'FAILED'],
  PASSED: ['MERGED'],
  MERGED: [],
  STALE: ['QUEUED', 'FAILED', 'NEEDS_REPLAN'],
  FAILED: ['ESCALATED_1', 'ESCALATED_2', 'NEEDS_REPLAN', 'QUEUED'],
  ESCALATED_1: ['RUNNING', 'ESCALATED_2', 'NEEDS_REPLAN'],
  ESCALATED_2: ['RUNNING', 'NEEDS_REPLAN'],
  NEEDS_REPLAN: ['DRAFT'],
  CANCELLED: [],
  ABANDONED: [],
};

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

export function nextStates(from: TaskState): readonly TaskState[] {
  if (isTerminal(from)) return [];
  const base = TABLE[from];
  // ALWAYS targets are appended unless already present or self.
  const extra = ALWAYS.filter((s) => s !== from && !base.includes(s));
  return [...base, ...extra];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return nextStates(from).includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;
  constructor(from: TaskState, to: TaskState) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
