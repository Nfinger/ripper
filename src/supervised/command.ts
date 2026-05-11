import type { SupervisedCommand } from '../cli/types.js';
import { handleLocksCommand } from './commands/locks.js';
import { handleProfilesCommand } from './commands/profiles.js';
import { handleRunCommand } from './commands/run.js';
import { handleRunsCommand } from './commands/runs.js';
import { EXIT_CONFIG_OR_SCHEMA } from './exit-codes.js';

export interface DispatchOptions {
  command: SupervisedCommand;
  argv: string[];
  noInteractive: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface DispatchResult {
  exitCode: number;
}

export async function dispatchSupervisedCommand(opts: DispatchOptions): Promise<DispatchResult> {
  if (opts.command === 'profiles') {
    return handleProfilesCommand({
      argv: opts.argv,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
  }

  if (opts.command === 'runs') {
    return handleRunsCommand({
      argv: opts.argv,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
  }

  if (opts.command === 'run') {
    return handleRunCommand({
      argv: opts.argv,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
  }

  if (opts.command === 'locks') {
    return handleLocksCommand({
      argv: opts.argv,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
  }

  opts.stderr(`symphony ${opts.command}: not implemented yet\n`);
  return { exitCode: EXIT_CONFIG_OR_SCHEMA };
}
