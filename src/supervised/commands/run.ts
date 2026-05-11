import os from 'node:os';
import { LinearReadAdapter, type LinearIssue } from '../adapters/linear.js';
import { EXIT_CONFIG_OR_SCHEMA } from '../exit-codes.js';
import { runDryRun, type DryRunLinearClient } from '../run/dry-run.js';
import { resumeRealRun, runRealRun, type RealRunClients } from '../run/real-run.js';

export interface RunCommandOptions {
  argv: string[];
  homeDir?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  linear?: DryRunLinearClient;
  realClients?: Partial<RealRunClients>;
}

export interface RunCommandResult {
  exitCode: number;
}

interface ParsedRunArgs {
  profileName: string;
  dryRun: boolean;
  issueKey?: string;
  resumeRunId?: string;
}

export async function handleRunCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const parsed = parseRunArgs(opts.argv);
  if (typeof parsed === 'string') {
    opts.stderr(`${parsed}\nUsage: symphony run <profile> [--issue <LINEAR-KEY>] [--dry-run] [--resume <RUN_ID>]\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  if (parsed.dryRun) {
    const result = await runDryRun({ profileName: parsed.profileName, homeDir: opts.homeDir ?? os.homedir(), ...(parsed.issueKey ? { issueKey: parsed.issueKey } : {}), linear: opts.linear ?? new LinearReadAdapter() });
    opts.stdout(`${result.message}\nRun record: ${result.run.run_dir}\n`);
    return { exitCode: result.exitCode };
  }
  if (parsed.resumeRunId) {
    const result = await resumeRealRun({ profileName: parsed.profileName, homeDir: opts.homeDir ?? os.homedir(), runId: parsed.resumeRunId, ...(opts.realClients ? { clients: opts.realClients } : {}) });
    opts.stdout(`${result.message}\nRun record: ${result.run.run_dir}\n`);
    return { exitCode: result.exitCode };
  }
  const realRunOptions = { profileName: parsed.profileName, homeDir: opts.homeDir ?? os.homedir(), ...(parsed.issueKey ? { issueKey: parsed.issueKey } : {}), ...(opts.realClients ? { clients: opts.realClients } : {}) };
  const result = await runRealRun(realRunOptions);
  opts.stdout(`${result.message}\nRun record: ${result.run.run_dir}\n`);
  return { exitCode: result.exitCode };
}

function parseRunArgs(argv: string[]): ParsedRunArgs | string {
  const [profileName, ...rest] = argv;
  if (!profileName) return 'Missing profile name';
  const parsed: ParsedRunArgs = { profileName, dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--issue') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) return '--issue requires a value';
      parsed.issueKey = value;
      index += 1;
      continue;
    }
    if (arg === '--resume') {
      const value = rest[index + 1];
      if (!value || value.startsWith('-')) return '--resume requires a value';
      parsed.resumeRunId = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('-')) return `Unknown option: ${arg}`;
    return `Unexpected argument: ${arg}`;
  }
  if (parsed.dryRun && parsed.resumeRunId) return '--resume cannot be combined with --dry-run';
  if (parsed.issueKey && parsed.resumeRunId) return '--resume cannot be combined with --issue';
  return parsed;
}

export type { LinearIssue };
