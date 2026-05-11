import { readFile } from 'node:fs/promises';
import type { CommandResult, RunCommandOptions } from '../command-runner/types.js';
import { runCommand } from '../command-runner/runner.js';
import type { AgentConfig } from '../profile/types.js';
import type { CodexReadinessResult } from '../run/preflight.js';
export type CodexFailureReason = 'codex_timeout' | 'codex_noninteractive_unavailable' | 'codex_unavailable' | 'codex_log_capture_failed';

export type CodexRunResult =
  | { ok: true; finalText: string; exitCode: number; timedOut: false }
  | { ok: false; reason: CodexFailureReason; exitCode: number; timedOut: boolean };

export interface CodexRunOptions {
  cwd: string;
  promptPath: string;
  rawLogPath: string;
  redactedLogPath: string;
  agent: AgentConfig;
  recordEvent?: RunCommandOptions['recordEvent'];
}

export interface CodexAdapterOptions {
  commandRunner?: (opts: RunCommandOptions) => Promise<CommandResult>;
}

export class CodexAdapter {
  private readonly commandRunner: (opts: RunCommandOptions) => Promise<CommandResult>;

  constructor(opts: CodexAdapterOptions = {}) {
    this.commandRunner = opts.commandRunner ?? runCommand;
  }

  async checkAvailable(command: string, minVersion?: string): Promise<CodexReadinessResult> {
    const versionResult = await this.commandRunner({ mode: 'argv', command, args: ['--version'], cwd: process.cwd(), timeoutMs: 30_000 });
    if (versionResult.exitCode !== 0) return { ok: false, code: 'codex_unavailable', reason: (versionResult.stderr || versionResult.stdout || `${command} --version failed`).trim() };
    const version = (versionResult.stdout || versionResult.stderr).trim();
    if (minVersion && !versionMeetsMinimum(version, minVersion)) return { ok: false, code: 'codex_version_too_old', version, reason: `Codex ${version} is older than required ${minVersion}` };

    const execHelp = await this.commandRunner({ mode: 'argv', command, args: ['exec', '--help'], cwd: process.cwd(), timeoutMs: 30_000 });
    if (execHelp.exitCode !== 0) return { ok: false, code: 'codex_noninteractive_unavailable', version, reason: (execHelp.stderr || execHelp.stdout || `${command} exec --help failed`).trim() };
    return { ok: true, version };
  }

  async run(opts: CodexRunOptions): Promise<CodexRunResult> {
    const commandOptions: RunCommandOptions = {
      mode: 'argv',
      command: opts.agent.command,
      args: buildCodexArgs(opts.agent),
      cwd: opts.cwd,
      timeoutMs: opts.agent.timeout_minutes * 60_000,
      rawLogPath: opts.rawLogPath,
      redactedLogPath: opts.redactedLogPath,
      stdin: await readFile(opts.promptPath, 'utf8'),
    };
    if (opts.recordEvent) commandOptions.recordEvent = opts.recordEvent;
    const result = await this.commandRunner(commandOptions);

    if (result.finalizationError) return { ok: false, reason: 'codex_log_capture_failed', exitCode: result.exitCode, timedOut: false };
    if (result.timedOut) return { ok: false, reason: 'codex_timeout', exitCode: result.exitCode, timedOut: true };
    if (result.exitCode !== 0) {
      return { ok: false, reason: isNoninteractiveUnavailable(result) ? 'codex_noninteractive_unavailable' : 'codex_unavailable', exitCode: result.exitCode, timedOut: false };
    }
    return { ok: true, finalText: extractFinalText(result), exitCode: result.exitCode, timedOut: false };
  }
}

function versionMeetsMinimum(rawVersion: string, minimum: string): boolean {
  const found = rawVersion.match(/\d+(?:\.\d+)*/)?.[0] ?? '0';
  const current = found.split('.').map((part) => Number.parseInt(part, 10));
  const required = minimum.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(current.length, required.length);
  for (let index = 0; index < length; index += 1) {
    const a = current[index] ?? 0;
    const b = required[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function buildCodexArgs(agent: AgentConfig): string[] {
  const args = ['exec', '--json', '--sandbox', 'danger-full-access'];
  if (agent.model) args.push('--model', agent.model);
  args.push('-');
  return args;
}

function isNoninteractiveUnavailable(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('unknown command') || output.includes('unrecognized subcommand') || output.includes('unexpected argument') || output.includes('non-interactive') || output.includes('noninteractive');
}

function extractFinalText(result: CommandResult): string {
  const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as { type?: unknown; item?: unknown; result?: unknown; message?: unknown };
      if (parsed.type === 'item.completed' && isRecord(parsed.item) && parsed.item.type === 'agent_message' && typeof parsed.item.text === 'string') return parsed.item.text;
      if (parsed.type === 'result' && typeof parsed.result === 'string') return parsed.result;
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      // Fall back to raw stdout below.
    }
  }
  return '[codex final output unavailable]';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
