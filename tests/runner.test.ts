import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runTurn } from '../src/agent/runner.js';
import type { AgentEvent } from '../src/agent/types.js';

class FakeChild extends EventEmitter {
  public pid = 12345;
  public stdin: Writable;
  public stdout: Readable;
  public stderr: Readable;
  public stdinChunks: string[] = [];

  constructor(public stdoutLines: string[], public stderrText = '', public exitCode: number | null = 0, public exitDelayMs = 5) {
    super();
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.stdinChunks.push(chunk.toString());
        cb();
      },
    });
    this.stdout = Readable.from(stdoutLines.map((l) => l + '\n'));
    this.stderr = Readable.from(stderrText ? [stderrText] : []);
    setTimeout(() => {
      this.emit('close', exitCode);
    }, exitDelayMs);
  }

  kill(_signal?: string): boolean {
    this.exitCode = null;
    this.emit('close', null);
    return true;
  }
}

function fakeSpawn(child: FakeChild) {
  return ((..._args: unknown[]) => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn;
}

const SAMPLE_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc-123',
  cwd: '/tmp/ws',
  tools: [],
  model: 'claude-opus-x',
});
const SAMPLE_ASSISTANT = JSON.stringify({
  type: 'assistant',
  session_id: 'sess-abc-123',
  message: {
    id: 'msg_1',
    role: 'assistant',
    content: [{ type: 'text', text: 'Working on it.' }],
    usage: { input_tokens: 200, output_tokens: 50 },
  },
});
const SAMPLE_RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4321,
  num_turns: 1,
  result: 'Done.',
  session_id: 'sess-abc-123',
  total_cost_usd: 0.04,
  usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 },
});

const CODEX_THREAD_STARTED = JSON.stringify({
  type: 'thread.started',
  thread_id: 'codex-thread-123',
});
const CODEX_AGENT_MESSAGE = JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_0', type: 'agent_message', text: 'Working via Codex.' },
});
const CODEX_TURN_COMPLETED = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 4 },
});

describe('runTurn (slice)', () => {
  it('emits session_started, turn_message, turn_completed and returns succeeded', async () => {
    const events: AgentEvent[] = [];
    const child = new FakeChild([SAMPLE_INIT, SAMPLE_ASSISTANT, SAMPLE_RESULT_OK]);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p --output-format stream-json --verbose',
      prompt: 'do the thing',
      turnNumber: 1,
      turnTimeoutMs: 10_000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.thread_id).toBe('sess-abc-123');
    expect(result.usage).toEqual({ input_tokens: 1200, output_tokens: 300, total_tokens: 1500 });
    expect(events.map((e) => e.event)).toEqual([
      'session_started',
      'turn_message',
      'turn_message',
      'turn_completed',
    ]);
    expect(child.stdinChunks.join('')).toBe('do the thing');
  });

  it('flags malformed lines without crashing', async () => {
    const events: AgentEvent[] = [];
    const child = new FakeChild(['not-json-{', SAMPLE_INIT, SAMPLE_RESULT_OK]);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 5000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('succeeded');
    expect(events.some((e) => e.event === 'malformed')).toBe(true);
  });

  it('flags result_is_error responses as failed', async () => {
    const events: AgentEvent[] = [];
    const errResult = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: 'sess-abc-123',
    });
    const child = new FakeChild([SAMPLE_INIT, errResult], '', 0);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 5000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('failed');
    expect(events.some((e) => e.event === 'turn_failed')).toBe(true);
  });

  it('does not treat string "false" is_error on success results as failed', async () => {
    const events: AgentEvent[] = [];
    const resultWithStringFalse = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: 'false',
      session_id: 'sess-abc-123',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    });
    const child = new FakeChild([SAMPLE_INIT, resultWithStringFalse], '', 0);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 5000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('succeeded');
    expect(events.some((e) => e.event === 'turn_failed')).toBe(false);
  });

  it('flags non-zero subprocess exits as failed', async () => {
    const events: AgentEvent[] = [];
    const child = new FakeChild([SAMPLE_INIT], 'oh no', 12);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 5000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('failed');
    expect(result.exit_code).toBe(12);
  });

  it('appends --resume and --permission-mode to the command', async () => {
    let observedCmd = '';
    const spawnImpl: typeof spawn = ((..._args: unknown[]) => {
      const argList = _args[1] as string[];
      observedCmd = argList[1] ?? '';
      return new FakeChild([SAMPLE_INIT, SAMPLE_RESULT_OK]) as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof spawn;
    await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p --output-format stream-json --verbose',
      prompt: 'go',
      turnNumber: 2,
      turnTimeoutMs: 5000,
      resumeThreadId: 'sess-prev',
      permissionMode: 'bypassPermissions',
      onEvent: () => {},
      spawnImpl,
    });
    expect(observedCmd).toContain('--resume ');
    expect(observedCmd).toContain('--permission-mode ');
    expect(observedCmd).toContain("'sess-prev'");
    expect(observedCmd).toContain("'bypassPermissions'");
  });

  it('parses Codex JSONL events when agentKind=codex', async () => {
    const events: AgentEvent[] = [];
    const child = new FakeChild([CODEX_THREAD_STARTED, CODEX_AGENT_MESSAGE, CODEX_TURN_COMPLETED]);
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      agentKind: 'codex',
      command: 'codex exec --json --sandbox workspace-write -m gpt-5.5',
      prompt: 'do the thing',
      turnNumber: 1,
      turnTimeoutMs: 10_000,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('succeeded');
    expect(result.thread_id).toBe('codex-thread-123');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 30, total_tokens: 130 });
    expect(events.map((e) => e.event)).toEqual([
      'session_started',
      'turn_message',
      'turn_completed',
    ]);
    expect(events.find((e) => e.event === 'turn_completed')).toMatchObject({
      result_text: 'Working via Codex.',
    });
  });

  it('does not append Claude-only permission or resume flags for Codex commands', async () => {
    let observedCmd = '';
    const spawnImpl: typeof spawn = ((..._args: unknown[]) => {
      const argList = _args[1] as string[];
      observedCmd = argList[1] ?? '';
      return new FakeChild([CODEX_THREAD_STARTED, CODEX_TURN_COMPLETED]) as unknown as ChildProcessWithoutNullStreams;
    }) as unknown as typeof spawn;
    await runTurn({
      workspacePath: '/tmp/ws',
      agentKind: 'codex',
      command: 'codex exec --json --sandbox workspace-write -m gpt-5.5',
      prompt: 'go',
      turnNumber: 2,
      turnTimeoutMs: 5000,
      resumeThreadId: 'codex-thread-prev',
      permissionMode: 'bypassPermissions',
      onEvent: () => {},
      spawnImpl,
    });
    expect(observedCmd).not.toContain('--permission-mode');
    expect(observedCmd).not.toContain('--resume ');
  });

  it('emits turn_timeout and returns timeout outcome on slow process', async () => {
    const events: AgentEvent[] = [];
    const child = new FakeChild([SAMPLE_INIT], '', 0, 100); // exits at 100ms but...
    // suppress the exit by replacing setTimeout-driven close
    child.removeAllListeners('close');
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 50,
      onEvent: (e) => events.push(e),
      spawnImpl: fakeSpawn(child),
    });
    expect(result.outcome).toBe('timeout');
    expect(events.some((e) => e.event === 'turn_timeout')).toBe(true);
  });

  it('returns startup_failed when spawn throws', async () => {
    const spawnImpl: typeof spawn = (() => {
      throw new Error('ENOENT bash');
    }) as unknown as typeof spawn;
    const events: AgentEvent[] = [];
    const result = await runTurn({
      workspacePath: '/tmp/ws',
      command: 'claude -p',
      prompt: 'go',
      turnNumber: 1,
      turnTimeoutMs: 5000,
      onEvent: (e) => events.push(e),
      spawnImpl,
    });
    expect(result.outcome).toBe('startup_failed');
    expect(events[0]?.event).toBe('startup_failed');
  });
});

describe('vi can mock console without leak', () => {
  it('placeholder', () => {
    expect(vi.isMockFunction(() => {})).toBe(false);
  });
});
