/**
 * Events emitted by the agent runner up to the orchestrator. Mirrors the
 * spirit of spec §10.4. Strings rather than enums so future agent transports
 * can add their own event names without protocol churn.
 */
export type AgentEvent =
  | {
      event: 'session_started';
      timestamp: string;
      thread_id: string;
      turn_id: string;
      pid: number | null;
    }
  | {
      event: 'turn_message';
      timestamp: string;
      thread_id: string | null;
      turn_id: string;
      role: 'assistant' | 'user' | 'system';
      raw: unknown;
    }
  | {
      event: 'turn_completed';
      timestamp: string;
      thread_id: string | null;
      turn_id: string;
      usage: TokenUsage | null;
      result_text: string | null;
      duration_ms: number | null;
    }
  | {
      event: 'turn_failed';
      timestamp: string;
      thread_id: string | null;
      turn_id: string;
      reason: string;
      raw?: unknown;
    }
  | {
      event: 'turn_timeout';
      timestamp: string;
      thread_id: string | null;
      turn_id: string;
      timeout_ms: number;
    }
  | {
      event: 'startup_failed';
      timestamp: string;
      turn_id: string;
      reason: string;
    }
  | {
      event: 'malformed';
      timestamp: string;
      thread_id: string | null;
      turn_id: string;
      raw: string;
      reason: string;
    };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type TurnOutcome = 'succeeded' | 'failed' | 'timeout' | 'startup_failed';

export interface TurnResult {
  outcome: TurnOutcome;
  thread_id: string | null;
  turn_id: string;
  usage: TokenUsage | null;
  exit_code: number | null;
  reason: string | null;
  duration_ms: number;
}
