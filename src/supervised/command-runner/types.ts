export type CommandMode = 'argv' | 'shell';

export interface CommandEvent {
  type: 'command_started' | 'command_finished';
  data: Record<string, unknown>;
}

export interface BaseCommandOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  rawLogPath?: string;
  redactedLogPath?: string;
  recordEvent?: (event: CommandEvent) => Promise<void> | void;
  stdin?: string;
}

export interface ArgvCommandOptions extends BaseCommandOptions {
  mode: 'argv';
  command: string;
  args: string[];
}

export interface ShellCommandOptions extends BaseCommandOptions {
  mode: 'shell';
  command: string;
  shell?: string;
}

export type RunCommandOptions = ArgvCommandOptions | ShellCommandOptions;

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  finalizationError?: string;
}
