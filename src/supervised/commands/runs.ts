import { copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_SUCCEEDED } from '../exit-codes.js';
import { indexPath, listRunIds, readRunById } from '../run-record/store.js';
import { writeFileAtomic } from '../storage/atomic.js';
import type { RunRecord, RunStatus } from '../run-record/types.js';

export interface RunsCommandOptions {
  argv: string[];
  homeDir?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface RunsCommandResult {
  exitCode: number;
}

interface RunIndexEntry {
  run_id: string;
  status: RunStatus;
  updated_at: string;
  issue_key?: string | null;
  profile_name?: string;
}

const TERMINAL_STATUSES = new Set<RunStatus>(['succeeded', 'succeeded_with_warnings', 'failed', 'timed_out', 'cancelled', 'refused', 'preflight_failed', 'dry_run']);

export async function handleRunsCommand(opts: RunsCommandOptions): Promise<RunsCommandResult> {
  const [subcommand, ...rest] = opts.argv;
  switch (subcommand) {
    case 'show':
      return showRun(rest, opts);
    case 'list':
      return listRuns(rest, opts);
    case 'rebuild-index':
      return rebuildIndex(rest, opts);
    case 'verify':
      return verifyRun(rest, opts);
    default:
      opts.stderr('Usage: symphony runs <show|list|rebuild-index|verify> ...\n');
      return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
}

async function showRun(argv: string[], opts: RunsCommandOptions): Promise<RunsCommandResult> {
  const runId = argv[0];
  if (!runId) {
    opts.stderr('Usage: symphony runs show <run_id> [--json]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const json = argv.includes('--json');
  try {
    const run = await readRunById(homeDir(opts), runId);
    opts.stdout(json ? `${JSON.stringify({ run }, null, 2)}\n` : formatRun(run));
    return { exitCode: EXIT_SUCCEEDED };
  } catch (error) {
    opts.stderr(`runs show: failed to read ${runId}: ${String(error)}\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
}

async function listRuns(argv: string[], opts: RunsCommandOptions): Promise<RunsCommandResult> {
  const json = argv.includes('--json');
  const entries = await readIndex(homeDir(opts));
  opts.stdout(json ? `${JSON.stringify({ runs: entries })}\n` : entries.map((entry) => `${entry.run_id}\t${entry.status}\t${entry.updated_at}\n`).join(''));
  return { exitCode: EXIT_SUCCEEDED };
}

async function rebuildIndex(_argv: string[], opts: RunsCommandOptions): Promise<RunsCommandResult> {
  const home = homeDir(opts);
  const indexFile = indexPath(home);
  if (existsSync(indexFile)) {
    await copyFile(indexFile, `${indexFile}.bak`);
  }
  const runIds = await listRunIds(home);
  const entries: RunIndexEntry[] = [];
  for (const runId of runIds) {
    try {
      entries.push(indexEntry(await readRunById(home, runId)));
    } catch {
      // Skip unreadable run directories; verify handles per-run integrity.
    }
  }
  await writeFileAtomic(indexFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''));
  opts.stdout(`Rebuilt index with ${entries.length} run(s)\n`);
  return { exitCode: EXIT_SUCCEEDED };
}

async function verifyRun(argv: string[], opts: RunsCommandOptions): Promise<RunsCommandResult> {
  const runId = argv[0];
  if (!runId) {
    opts.stderr('Usage: symphony runs verify <run_id> [--json]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const json = argv.includes('--json');
  const errors: string[] = [];
  try {
    const run = await readRunById(homeDir(opts), runId);
    await verifyEvents(run.run_dir, errors);
    if (TERMINAL_STATUSES.has(run.status) && !existsSync(path.join(run.run_dir, 'result.md'))) {
      errors.push('missing_result_md_for_terminal_state');
    }
    if (!existsSync(path.join(run.run_dir, 'artifacts.json'))) {
      errors.push('missing_artifacts_json');
    }
  } catch (error) {
    errors.push(`run_unreadable:${String(error)}`);
  }

  const ok = errors.length === 0;
  if (json) opts.stdout(`${JSON.stringify({ ok, errors })}\n`);
  else opts.stdout(ok ? `Run ${runId} verified\n` : `Run ${runId} invalid:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
  return { exitCode: ok ? EXIT_SUCCEEDED : EXIT_CONFIG_OR_SCHEMA };
}

async function readIndex(home: string): Promise<RunIndexEntry[]> {
  const file = indexPath(home);
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
    const byRunId = new Map<string, RunIndexEntry>();
    for (const line of lines) {
      const entry = JSON.parse(line) as RunIndexEntry;
      byRunId.set(entry.run_id, entry);
    }
    return [...byRunId.values()];
  } catch {
    return [];
  }
}

async function verifyEvents(runDir: string, errors: string[]): Promise<void> {
  try {
    const content = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    for (const [index, line] of content.trim().split('\n').filter(Boolean).entries()) {
      try {
        JSON.parse(line);
      } catch {
        errors.push(`invalid_events_jsonl_line:${index + 1}`);
      }
    }
  } catch {
    errors.push('missing_events_jsonl');
  }
}

function indexEntry(run: RunRecord): RunIndexEntry {
  return { run_id: run.run_id, status: run.status, updated_at: run.updated_at, issue_key: run.issue_key, profile_name: run.profile_name };
}

function formatRun(run: RunRecord): string {
  return `${run.run_id}\t${run.status}\t${run.updated_at}\n`;
}

function homeDir(opts: RunsCommandOptions): string {
  return opts.homeDir ?? os.homedir();
}
