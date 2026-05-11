import os from 'node:os';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_LOCK_EXISTS, EXIT_SUCCEEDED } from '../exit-codes.js';
import { readRepoLock, releaseRepoLock } from '../locks/store.js';

export interface LocksCommandOptions {
  argv: string[];
  homeDir?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface LocksCommandResult {
  exitCode: number;
}

export async function handleLocksCommand(opts: LocksCommandOptions): Promise<LocksCommandResult> {
  const [command, repoPath, ...rest] = opts.argv;
  const homeDir = opts.homeDir ?? os.homedir();
  if (!command || !repoPath) {
    opts.stderr('Usage: symphony locks <status|unlock> <repo-path> [--json] [--reason <text>]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }

  const parsed = parseCommonArgs(rest);
  if (typeof parsed === 'string') {
    opts.stderr(`${parsed}\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }

  if (command === 'status') {
    const lock = await readRepoLock(homeDir, repoPath);
    if (parsed.json) {
      opts.stdout(`${JSON.stringify({ locked: lock !== null, lock }, null, 2)}\n`);
    } else {
      opts.stdout(lock ? `locked: ${lock.repo_path} by ${lock.run_id ?? 'unknown run'}\n` : `unlocked: ${repoPath}\n`);
    }
    return { exitCode: lock ? EXIT_LOCK_EXISTS : EXIT_SUCCEEDED };
  }

  if (command === 'unlock') {
    const reason = parsed.reason?.trim();
    if (!reason) {
      opts.stderr('--reason requires a value\n');
      return { exitCode: EXIT_CONFIG_OR_SCHEMA };
    }
    const result = await releaseRepoLock({ homeDir, repoPath, reason });
    if (parsed.json) {
      opts.stdout(`${JSON.stringify({ ok: true, released: result.released }, null, 2)}\n`);
    } else {
      opts.stdout(result.released ? `released lock for ${repoPath}\n` : `no lock for ${repoPath}\n`);
    }
    return { exitCode: EXIT_SUCCEEDED };
  }

  opts.stderr(`Unknown locks command: ${command}\n`);
  return { exitCode: EXIT_CONFIG_OR_SCHEMA };
}

interface ParsedArgs {
  json: boolean;
  reason?: string;
}

function parseCommonArgs(args: string[]): ParsedArgs | string {
  const parsed: ParsedArgs = { json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--reason') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) return '--reason requires a value';
      parsed.reason = value;
      index += 1;
      continue;
    }
    return `Unknown option: ${arg}`;
  }
  return parsed;
}
