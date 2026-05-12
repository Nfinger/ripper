import type { Issue, ServiceConfig } from '../workflow/types.js';
import type { OrchestratorState } from './state.js';

const TODO_STATE = 'todo';

export interface DispatchSlots {
  global_available: number;
  per_state: Map<string, number>;
}

/**
 * Spec §8.3 — current available slots, both global and per-state.
 */
export function computeAvailableSlots(state: OrchestratorState, config: ServiceConfig): DispatchSlots {
  const globalAvailable = Math.max(state.max_concurrent_agents - state.running.size, 0);

  const usedByState = new Map<string, number>();
  for (const entry of state.running.values()) {
    const key = entry.issue.state.toLowerCase();
    usedByState.set(key, (usedByState.get(key) ?? 0) + 1);
  }
  const perState = new Map<string, number>();
  for (const [stateKey, limit] of Object.entries(config.agent.max_concurrent_agents_by_state)) {
    perState.set(stateKey.toLowerCase(), Math.max(limit - (usedByState.get(stateKey.toLowerCase()) ?? 0), 0));
  }
  return { global_available: globalAvailable, per_state: perState };
}

/**
 * Spec §8.2 — checks an issue is dispatch-eligible.
 */
export function isEligible(
  issue: Issue,
  state: OrchestratorState,
  config: ServiceConfig,
  slots: DispatchSlots,
): boolean {
  if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
  const stateLower = issue.state.toLowerCase();
  const activeSet = new Set(config.tracker.active_states.map((s) => s.toLowerCase()));
  const terminalSet = new Set(config.tracker.terminal_states.map((s) => s.toLowerCase()));
  if (!activeSet.has(stateLower)) return false;
  if (terminalSet.has(stateLower)) return false;
  if (config.tracker.assignee_ids.length > 0 && !config.tracker.assignee_ids.includes(issue.assignee_id ?? '')) return false;
  if (config.tracker.assignee_names.length > 0 && !config.tracker.assignee_names.includes(issue.assignee_name ?? '')) return false;
  if (config.tracker.required_labels.length > 0) {
    for (const required of config.tracker.required_labels) {
      if (!issue.labels.includes(required.toLowerCase())) return false;
    }
  }
  if (config.tracker.excluded_labels.some((label) => issue.labels.includes(label.toLowerCase()))) return false;
  if (state.running.has(issue.id)) return false;
  if (state.claimed.has(issue.id)) return false;
  if (state.completed.has(issue.id)) return false;
  if (slots.global_available <= 0) return false;
  if (slots.per_state.has(stateLower)) {
    const left = slots.per_state.get(stateLower) ?? 0;
    if (left <= 0) return false;
  }
  if (stateLower === TODO_STATE) {
    for (const blocker of issue.blocked_by) {
      const blockerStateLower = (blocker.state ?? '').toLowerCase();
      if (!terminalSet.has(blockerStateLower)) return false;
    }
  }
  return true;
}

/**
 * Spec §8.2 — dispatch sort order.
 */
export function sortForDispatch(issues: Issue[]): Issue[] {
  const copy = [...issues];
  copy.sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    const ta = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const tb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ta) || Number.isFinite(tb)) {
      const taF = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
      const tbF = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
      if (taF !== tbF) return taF - tbF;
    }
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
  return copy;
}

/**
 * Spec §8.4 — failure backoff: min(10000 * 2^(attempt-1), max). Continuation
 * (post normal-exit) uses a fixed 1s.
 */
export const CONTINUATION_DELAY_MS = 1000;

export function computeBackoffMs(attempt: number, maxBackoffMs: number): number {
  if (attempt < 1) return 0;
  const exp = Math.pow(2, attempt - 1);
  return Math.min(10_000 * exp, maxBackoffMs);
}
