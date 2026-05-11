import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../src/supervised/adapters/codex.js';
import type { RunCommandOptions } from '../src/supervised/command-runner/types.js';
import type { AgentConfig } from '../src/supervised/profile/types.js';

const agent: AgentConfig = { kind: 'codex', command: 'codex', model: 'gpt-5.5', timeout_minutes: 7, allow_network: true, allow_web_lookup: true, allow_browser_automation: false };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-codex-adapter-'));
}

describe('CodexAdapter', () => {
  it('runs codex exec non-interactively with prompt on stdin instead of a prompt file argument', async () => {
    const cwd = await tempDir();
    const promptPath = join(cwd, 'prompt.md');
    await writeFile(promptPath, 'implement the ticket');
    let options: RunCommandOptions | null = null;
    const adapter = new CodexAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => {
      options = opts;
      return { command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n', stderr: '', durationMs: 10 };
    }) });

    const result = await adapter.run({ cwd, promptPath, rawLogPath: join(cwd, 'codex.log'), redactedLogPath: join(cwd, 'codex.redacted.log'), agent });

    expect(result).toEqual({ ok: true, finalText: 'done', exitCode: 0, timedOut: false });
    expect(options).toMatchObject({ mode: 'argv', command: 'codex', cwd, timeoutMs: 7 * 60_000, stdin: 'implement the ticket' });
    expect(options && options.mode === 'argv' ? options.args : []).toEqual(['exec', '--json', '--sandbox', 'danger-full-access', '--model', 'gpt-5.5', '-']);
    expect(JSON.stringify(options)).not.toContain(promptPath);
  });

  it('maps unexpected argument / exec incompatibility to codex_noninteractive_unavailable', async () => {
    const cwd = await tempDir();
    const promptPath = join(cwd, 'prompt.md');
    await writeFile(promptPath, 'prompt');
    const adapter = new CodexAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 2, signal: null, timedOut: false, stdout: '', stderr: "error: unexpected argument '--json' found", durationMs: 10 })) });

    await expect(adapter.run({ cwd, promptPath, rawLogPath: join(cwd, 'codex.log'), redactedLogPath: join(cwd, 'codex.redacted.log'), agent })).resolves.toMatchObject({ ok: false, reason: 'codex_noninteractive_unavailable' });
  });

  it('does not expose raw unstructured stdout as final text', async () => {
    const cwd = await tempDir();
    const promptPath = join(cwd, 'prompt.md');
    await writeFile(promptPath, 'prompt');
    const adapter = new CodexAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '{"type":"unknown","secret":"raw-jsonl"}\nnot json\n', stderr: '', durationMs: 10 })) });

    await expect(adapter.run({ cwd, promptPath, rawLogPath: join(cwd, 'codex.log'), redactedLogPath: join(cwd, 'codex.redacted.log'), agent })).resolves.toEqual({ ok: true, finalText: '[codex final output unavailable]', exitCode: 0, timedOut: false });
  });

  it('fails when command log finalization fails', async () => {
    const cwd = await tempDir();
    const promptPath = join(cwd, 'prompt.md');
    await writeFile(promptPath, 'prompt');
    const adapter = new CodexAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n', stderr: '', durationMs: 10, finalizationError: 'disk full' })) });

    await expect(adapter.run({ cwd, promptPath, rawLogPath: join(cwd, 'codex.log'), redactedLogPath: join(cwd, 'codex.redacted.log'), agent })).resolves.toMatchObject({ ok: false, reason: 'codex_log_capture_failed' });
  });
});
