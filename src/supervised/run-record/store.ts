import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../storage/atomic.js';
import type { ArtifactsManifest, CreateRunRecordOptions, RunEvent, RunRecord } from './types.js';

export interface RunIndexEntry {
  run_id: string;
  status: RunRecord['status'];
  updated_at: string;
  issue_key: string | null;
  profile_name: string;
}

export function generateRunId(issueKey: string | null, now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const suffix = issueKey ? `-${sanitizeRunIdSegment(issueKey)}` : '';
  return `${timestamp}${suffix}`;
}

export async function createRunRecord(opts: CreateRunRecordOptions): Promise<RunRecord> {
  const now = opts.now ?? new Date();
  const timestamp = now.toISOString();
  const baseRunId = opts.runId ?? generateRunId(opts.issueKey, now);
  assertValidRunId(baseRunId);
  const runsDirectory = runsDir(opts.homeDir);
  await mkdir(runsDirectory, { recursive: true });
  const runId = opts.runId ? baseRunId : await reserveUniqueRunDir(opts.homeDir, baseRunId);
  const runDir = runDirForId(opts.homeDir, runId);
  if (opts.runId) await mkdir(runDir, { recursive: false });

  const run: RunRecord = {
    schema_version: 1,
    run_id: runId,
    run_dir: runDir,
    profile_name: opts.profileName,
    profile_hash: opts.profileHash,
    issue_key: opts.issueKey,
    mutating: opts.mutating,
    status: 'initialized',
    reason: null,
    created_at: timestamp,
    updated_at: timestamp,
    artifacts_path: path.join(runDir, 'artifacts.json'),
    events_path: path.join(runDir, 'events.jsonl'),
  };

  const artifacts: ArtifactsManifest = { schema_version: 1, run_id: runId, artifacts: [] };
  await updateRunJson(runDir, run);
  await writeJsonAtomic(path.join(runDir, 'artifacts.json'), artifacts);
  await appendEvent(runDir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: runId,
    timestamp,
    type: 'run_created',
    data: { status: 'initialized', profile_name: opts.profileName, issue_key: opts.issueKey, mutating: opts.mutating },
  });
  await appendIndexEntry(opts.homeDir, run);
  return run;
}

export function runDirForId(homeDir: string, runId: string): string {
  assertValidRunId(runId);
  return path.join(runsDir(homeDir), runId);
}

export function runsDir(homeDir: string): string {
  return path.join(homeDir, '.symphony', 'runs');
}

export function indexPath(homeDir: string): string {
  return path.join(runsDir(homeDir), 'index.jsonl');
}

export async function readRunJson(runDir: string): Promise<RunRecord> {
  return JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as RunRecord;
}

export async function readRunById(homeDir: string, runId: string): Promise<RunRecord> {
  return readRunJson(runDirForId(homeDir, runId));
}

export async function updateRunJson(runDir: string, run: RunRecord): Promise<void> {
  await writeJsonAtomic(path.join(runDir, 'run.json'), run);
}

export async function listRunIds(homeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDir(homeDir), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isValidRunId(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function appendIndexEntry(homeDir: string, run: RunRecord): Promise<void> {
  await mkdir(runsDir(homeDir), { recursive: true });
  const entry: RunIndexEntry = { run_id: run.run_id, status: run.status, updated_at: run.updated_at, issue_key: run.issue_key, profile_name: run.profile_name };
  await appendLineAndFsync(indexPath(homeDir), JSON.stringify(entry));
}

export async function appendEvent(runDir: string, event: RunEvent): Promise<void> {
  await appendLineAndFsync(path.join(runDir, 'events.jsonl'), JSON.stringify(event));
}

async function appendLineAndFsync(filePath: string, line: string): Promise<void> {
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(`${line}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertValidRunId(runId: string): void {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

async function reserveUniqueRunDir(homeDir: string, baseRunId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runId = attempt === 0 ? baseRunId : `${baseRunId}-${attempt}`;
    try {
      await mkdir(runDirForId(homeDir, runId), { recursive: false });
      return runId;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Unable to reserve unique run directory for ${baseRunId}`);
}

export function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId) && !runId.includes('..');
}

function sanitizeRunIdSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/gu, '-');
}
