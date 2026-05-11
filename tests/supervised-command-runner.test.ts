import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/supervised/command-runner/runner.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-command-runner-'));
}

describe('supervised command runner', () => {
  it('executes argv commands with cwd and captures stdout/stderr', async () => {
    const cwd = await tempDir();

    const result = await runCommand({ mode: 'argv', command: process.execPath, args: ['-e', "console.log(process.cwd()); console.error('err')"], cwd, timeoutMs: 2000 });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe(await realpath(cwd));
    expect(result.stderr.trim()).toBe('err');
  });

  it('times out and kills the process', async () => {
    const cwd = await tempDir();

    const result = await runCommand({ mode: 'argv', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10_000)'], cwd, timeoutMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('writes raw and redacted log artifacts', async () => {
    const cwd = await tempDir();
    const rawLogPath = join(cwd, 'raw.log');
    const redactedLogPath = join(cwd, 'redacted.log');

    await runCommand({
      mode: 'argv',
      command: process.execPath,
      args: ['-e', "console.log('Authorization: Bearer secret-token')"],
      cwd,
      timeoutMs: 2000,
      rawLogPath,
      redactedLogPath,
    });

    expect(await readFile(rawLogPath, 'utf8')).toContain('secret-token');
    expect(await readFile(redactedLogPath, 'utf8')).toContain('Authorization: Bearer [REDACTED]');
  });

  it('passes optional stdin to argv commands', async () => {
    const cwd = await tempDir();

    const result = await runCommand({ mode: 'argv', command: process.execPath, args: ['-e', "process.stdin.pipe(process.stdout)"], cwd, timeoutMs: 2000, stdin: 'hello from stdin' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from stdin');
  });

  it('requires shell commands to use explicit shell mode', async () => {
    const cwd = await tempDir();

    const argvResult = await runCommand({ mode: 'argv', command: 'printf hi && printf bye', args: [], cwd, timeoutMs: 2000 });
    const shellResult = await runCommand({ mode: 'shell', command: 'printf hi && printf bye', cwd, timeoutMs: 2000 });

    expect(argvResult.exitCode).not.toBe(0);
    expect(shellResult.exitCode).toBe(0);
    expect(shellResult.stdout).toBe('hibye');
  });

  it('emits command events through injected recorder', async () => {
    const cwd = await tempDir();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await runCommand({
      mode: 'argv',
      command: process.execPath,
      args: ['-e', "console.log('ok')"],
      cwd,
      timeoutMs: 2000,
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['command_started', 'command_finished']);
    expect(events[0]?.data.command).toBe(process.execPath);
  });

  it('does not hang when finalization event recording fails', async () => {
    const cwd = await tempDir();
    let calls = 0;

    const result = await runCommand({
      mode: 'argv',
      command: process.execPath,
      args: ['-e', "console.log('ok')"],
      cwd,
      timeoutMs: 2000,
      recordEvent: async () => {
        calls += 1;
        if (calls === 2) throw new Error('event store unavailable');
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalizationError).toContain('event store unavailable');
  });

  it('redacts shell command strings in command events', async () => {
    const cwd = await tempDir();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];

    await runCommand({
      mode: 'shell',
      command: 'printf "Authorization: Bearer secret-token"',
      cwd,
      timeoutMs: 2000,
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    expect(events[0]?.data.command).toBe('printf "Authorization: Bearer [REDACTED]"');
    expect(events[1]?.data.command).toBe('printf "Authorization: Bearer [REDACTED]"');
  });
});
