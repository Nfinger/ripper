import { spawn } from 'node:child_process';
import { redactText } from '../safety/redaction.js';
import { writeFileAtomic } from '../storage/atomic.js';
import type { CommandResult, RunCommandOptions } from './types.js';

export async function runCommand(opts: RunCommandOptions): Promise<CommandResult> {
  const startedAt = Date.now();
  const command = opts.mode === 'shell' ? (opts.shell ?? '/bin/bash') : opts.command;
  const args = opts.mode === 'shell' ? ['-lc', opts.command] : opts.args;
  await opts.recordEvent?.({ type: 'command_started', data: { command: safeCommandForEvent(opts), mode: opts.mode, cwd: opts.cwd } });

  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      setTimeout(() => {
        if (!settled) killProcessGroup(child.pid, 'SIGKILL');
      }, 100).unref();
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += `failed to spawn command: ${error.message}\n`;
    });
    child.on('close', (exitCode, signal) => {
      settled = true;
      clearTimeout(timer);
      const normalizedExitCode = normalizeExitCode(exitCode, signal, timedOut);
      const result: CommandResult = {
        command: opts.command,
        args,
        cwd: opts.cwd,
        exitCode: normalizedExitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
      void finalize(opts, result)
        .catch((error: unknown) => {
          result.finalizationError = error instanceof Error ? error.message : String(error);
        })
        .then(() => resolve(result));
    });
  });
}

async function finalize(opts: RunCommandOptions, result: CommandResult): Promise<void> {
  const combined = renderLog(result, opts.mode);
  if (opts.rawLogPath) await writeFileAtomic(opts.rawLogPath, combined);
  if (opts.redactedLogPath) await writeFileAtomic(opts.redactedLogPath, redactText(combined));
  await opts.recordEvent?.({
    type: 'command_finished',
    data: { command: safeCommandForEvent(opts), mode: opts.mode, exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, duration_ms: result.durationMs },
  });
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function normalizeExitCode(exitCode: number | null, signal: NodeJS.Signals | null, timedOut: boolean): number {
  if (typeof exitCode === 'number') return timedOut && exitCode === 0 ? 1 : exitCode;
  if (timedOut) return 124;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGKILL') return 137;
  return 1;
}

function safeCommandForEvent(opts: RunCommandOptions): string {
  return redactText(opts.command);
}

function renderLog(result: CommandResult, mode: RunCommandOptions['mode']): string {
  const display = mode === 'shell' ? `$ ${result.command}` : `$ ${[result.command, ...result.args].map(shellQuote).join(' ')}`;
  return [display.trim(), '', '[stdout]', result.stdout, '[stderr]', result.stderr].join('\n');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
