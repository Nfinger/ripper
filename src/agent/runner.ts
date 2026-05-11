import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

import type { AgentEvent, TokenUsage, TurnResult } from './types.js';

type AgentKind = 'claude' | 'codex';

export interface RunTurnOptions {
  /** Absolute path to the per-issue workspace. Sent as cwd. */
  workspacePath: string;
  /** Shell command for the agent CLI (spec §10.1 — invoked via `bash -lc`). */
  command: string;
  /** Agent JSONL protocol emitted by the command. Defaults to Claude for legacy configs. */
  agentKind?: AgentKind;
  /** Optional continuation thread/session id. */
  resumeThreadId?: string | null;
  /** Permission mode (Claude-specific). Adds `--permission-mode <mode>` if set. */
  permissionMode?: string | null;
  /** The full rendered prompt for this turn. Sent on stdin. */
  prompt: string;
  /** Worker-local turn counter used to compose session_id. */
  turnNumber: number;
  /** Spec §5.3.6 — total turn timeout. */
  turnTimeoutMs: number;
  /** Callback invoked synchronously for each event. Must not block. */
  onEvent: (event: AgentEvent) => void;
  /** Override for tests. */
  spawnImpl?: typeof spawn;
}

const ENCODER = (() => new TextEncoder())();
void ENCODER;

/**
 * Run one agent turn end-to-end against the Claude Code CLI. Returns when the
 * subprocess exits, the turn timer fires, or a stream-json `result` event
 * arrives with a terminal subtype.
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const turnId = `t${opts.turnNumber}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const agentKind = opts.agentKind ?? 'claude';

  const cmd = buildShellCommand(opts.command, {
    agentKind,
    resumeThreadId: opts.resumeThreadId ?? null,
    permissionMode: opts.permissionMode ?? null,
  });

  const spawnFn = opts.spawnImpl ?? spawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn('bash', ['-lc', cmd], {
      cwd: opts.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    const msg = `failed to spawn agent: ${(err as Error).message}`;
    opts.onEvent({
      event: 'startup_failed',
      timestamp: new Date().toISOString(),
      turn_id: turnId,
      reason: msg,
    });
    return {
      outcome: 'startup_failed',
      thread_id: null,
      turn_id: turnId,
      usage: null,
      exit_code: null,
      reason: msg,
      duration_ms: Date.now() - startedAt,
    };
  }

  child.stdin.write(opts.prompt);
  child.stdin.end();

  let threadId: string | null = null;
  let lastUsage: TokenUsage | null = null;
  let resultText: string | null = null;
  let resultDurationMs: number | null = null;
  let resultIsError = false;
  let resultErrorReason: string | null = null;
  let stderrBuf = '';

  const stdoutLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutLines.on('line', (line) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      opts.onEvent({
        event: 'malformed',
        timestamp: new Date().toISOString(),
        thread_id: threadId,
        turn_id: turnId,
        raw: line.length > 4000 ? line.slice(0, 4000) + '…' : line,
        reason: (err as Error).message,
      });
      return;
    }
    if (!isObject(parsed)) return;
    const type = stringField(parsed, 'type');

    if (agentKind === 'codex') {
      if (type === 'thread.started') {
        const codexThreadId = stringField(parsed, 'thread_id');
        if (codexThreadId && !threadId) {
          threadId = codexThreadId;
          opts.onEvent({
            event: 'session_started',
            timestamp: new Date().toISOString(),
            thread_id: threadId,
            turn_id: turnId,
            pid: child.pid ?? null,
          });
        }
        return;
      }
      if (type === 'item.completed') {
        const item = parsed.item;
        if (isObject(item) && stringField(item, 'type') === 'agent_message') {
          resultText = stringField(item, 'text') ?? resultText;
          opts.onEvent({
            event: 'turn_message',
            timestamp: new Date().toISOString(),
            thread_id: threadId,
            turn_id: turnId,
            role: 'assistant',
            raw: parsed,
          });
        }
        const usage = extractUsage(parsed);
        if (usage) lastUsage = usage;
        return;
      }
      if (type === 'turn.completed') {
        const usage = extractUsage(parsed);
        if (usage) lastUsage = usage;
        return;
      }
      if (type === 'turn.failed' || type === 'error') {
        resultIsError = true;
        const message =
          stringField(parsed, 'message') ??
          stringField(parsed, 'error') ??
          stringField(parsed, 'reason');
        resultErrorReason = message
          ? `codex reported ${type}: ${message}`
          : `codex reported ${type}: ${JSON.stringify(parsed).slice(0, 2000)}`;
        return;
      }
      return;
    }

    const sessionId = stringField(parsed, 'session_id');
    if (sessionId && !threadId) {
      threadId = sessionId;
      opts.onEvent({
        event: 'session_started',
        timestamp: new Date().toISOString(),
        thread_id: threadId,
        turn_id: turnId,
        pid: child.pid ?? null,
      });
    }
    if (type === 'assistant' || type === 'user' || type === 'system') {
      opts.onEvent({
        event: 'turn_message',
        timestamp: new Date().toISOString(),
        thread_id: threadId,
        turn_id: turnId,
        role: type,
        raw: parsed,
      });
      const usage = extractUsage(parsed);
      if (usage) lastUsage = usage;
      return;
    }
    if (type === 'result') {
      const subtype = stringField(parsed, 'subtype');
      resultIsError = isTruthyResultError((parsed as Record<string, unknown>).is_error);
      resultText = stringField(parsed, 'result');
      const dur = numberField(parsed, 'duration_ms');
      if (dur !== null) resultDurationMs = dur;
      const usage = extractUsage(parsed);
      if (usage) lastUsage = usage;
      if (resultIsError) {
        resultErrorReason = `claude reported result error (subtype=${subtype ?? 'unknown'})`;
      } else if (subtype && subtype !== 'success') {
        resultIsError = true;
        resultErrorReason = `claude finished with non-success subtype: ${subtype}`;
      }
      return;
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000);
  });

  const exitInfo = await waitForExit(child, opts.turnTimeoutMs);

  if (exitInfo.timeout) {
    opts.onEvent({
      event: 'turn_timeout',
      timestamp: new Date().toISOString(),
      thread_id: threadId,
      turn_id: turnId,
      timeout_ms: opts.turnTimeoutMs,
    });
    return {
      outcome: 'timeout',
      thread_id: threadId,
      turn_id: turnId,
      usage: lastUsage,
      exit_code: null,
      reason: `turn exceeded ${opts.turnTimeoutMs}ms`,
      duration_ms: Date.now() - startedAt,
    };
  }

  if (exitInfo.exitCode === 0 && !resultIsError) {
    opts.onEvent({
      event: 'turn_completed',
      timestamp: new Date().toISOString(),
      thread_id: threadId,
      turn_id: turnId,
      usage: lastUsage,
      result_text: resultText,
      duration_ms: resultDurationMs,
    });
    return {
      outcome: 'succeeded',
      thread_id: threadId,
      turn_id: turnId,
      usage: lastUsage,
      exit_code: exitInfo.exitCode,
      reason: null,
      duration_ms: Date.now() - startedAt,
    };
  }

  const reason =
    resultErrorReason ??
    (stderrBuf.trim().length > 0
      ? `claude exited with code ${exitInfo.exitCode}: ${stderrBuf.trim().slice(-2000)}`
      : `claude exited with code ${exitInfo.exitCode}`);
  opts.onEvent({
    event: 'turn_failed',
    timestamp: new Date().toISOString(),
    thread_id: threadId,
    turn_id: turnId,
    reason,
  });
  return {
    outcome: 'failed',
    thread_id: threadId,
    turn_id: turnId,
    usage: lastUsage,
    exit_code: exitInfo.exitCode,
    reason,
    duration_ms: Date.now() - startedAt,
  };
}

interface ShellArgs {
  agentKind: AgentKind;
  resumeThreadId: string | null;
  permissionMode: string | null;
}

function buildShellCommand(baseCommand: string, args: ShellArgs): string {
  const parts: string[] = [baseCommand];
  if (args.agentKind === 'claude') {
    if (args.resumeThreadId) parts.push(`--resume ${shellQuote(args.resumeThreadId)}`);
    if (args.permissionMode) parts.push(`--permission-mode ${shellQuote(args.permissionMode)}`);
  }
  return parts.join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ExitInfo {
  exitCode: number | null;
  timeout: boolean;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ExitInfo> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ exitCode: null, timeout: true });
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timeout: false });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timeout: false });
    });
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function extractUsage(parsed: Record<string, unknown>): TokenUsage | null {
  const candidates: unknown[] = [parsed.usage];
  const message = parsed.message;
  if (isObject(message)) candidates.push(message.usage);
  for (const c of candidates) {
    if (!isObject(c)) continue;
    const input = numericField(c, ['input_tokens', 'prompt_tokens', 'inputTokens']);
    const output = numericField(c, ['output_tokens', 'completion_tokens', 'outputTokens']);
    const total = numericField(c, ['total_tokens', 'totalTokens']);
    if (input === null && output === null && total === null) continue;
    const inputN = input ?? 0;
    const outputN = output ?? 0;
    return {
      input_tokens: inputN,
      output_tokens: outputN,
      total_tokens: total ?? inputN + outputN,
    };
  }
  return null;
}

function numericField(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function isTruthyResultError(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}
