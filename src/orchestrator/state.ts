import type { Issue } from '../workflow/types.js';
import type { TokenUsage } from '../agent/types.js';

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  worker_promise: Promise<WorkerExit>;
  abort: AbortController;
  retry_attempt: number | null;
  started_at: number; // ms epoch
  turn_count: number;
  thread_id: string | null;
  session_id: string | null;
  claude_pid: number | null;
  last_event: string | null;
  last_event_at: number | null; // ms epoch
  last_message: unknown;
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number; // monotonic-ish: Date.now() based
  timer_handle: NodeJS.Timeout;
  error: string | null;
}

export interface ClaudeTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Cumulative seconds for already-ended sessions. Active sessions are
   *  added at snapshot time. */
  ended_session_seconds: number;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  totals: ClaudeTotals;
  rate_limits: unknown | null;
}

export type WorkerExit =
  | { kind: 'normal'; turns: number }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; reason: string; turns: number }
  | { kind: 'timeout'; reason: string; turns: number }
  | { kind: 'workspace_error'; reason: string }
  | { kind: 'startup_failed'; reason: string };

export function createInitialState(opts: {
  poll_interval_ms: number;
  max_concurrent_agents: number;
}): OrchestratorState {
  return {
    poll_interval_ms: opts.poll_interval_ms,
    max_concurrent_agents: opts.max_concurrent_agents,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    completed: new Set(),
    totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, ended_session_seconds: 0 },
    rate_limits: null,
  };
}

export function applyTokenDelta(running: RunningEntry, usage: TokenUsage): void {
  if (usage.input_tokens > running.last_reported_input_tokens) {
    running.claude_input_tokens += usage.input_tokens - running.last_reported_input_tokens;
    running.last_reported_input_tokens = usage.input_tokens;
  }
  if (usage.output_tokens > running.last_reported_output_tokens) {
    running.claude_output_tokens += usage.output_tokens - running.last_reported_output_tokens;
    running.last_reported_output_tokens = usage.output_tokens;
  }
  if (usage.total_tokens > running.last_reported_total_tokens) {
    running.claude_total_tokens += usage.total_tokens - running.last_reported_total_tokens;
    running.last_reported_total_tokens = usage.total_tokens;
  }
}

export function rollupTotalsForExit(state: OrchestratorState, entry: RunningEntry, now: number): void {
  state.totals.input_tokens += entry.claude_input_tokens;
  state.totals.output_tokens += entry.claude_output_tokens;
  state.totals.total_tokens += entry.claude_total_tokens;
  state.totals.ended_session_seconds += Math.max(0, (now - entry.started_at) / 1000);
}
