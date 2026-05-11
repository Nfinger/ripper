import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendEvent, createRunRecord, generateRunId, runDirForId, updateRunJson } from '../src/supervised/run-record/store.js';
import type { RunEvent } from '../src/supervised/run-record/types.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-run-record-'));
}

describe('run record store', () => {
  it('generates run ids with UTC timestamp and issue key', () => {
    const id = generateRunId('ENG-123', new Date('2026-05-10T07:45:09.123Z'));

    expect(id).toBe('20260510T074509Z-ENG-123');
  });

  it('creates run.json, events.jsonl, artifacts.json, and initial event', async () => {
    const homeDir = await tempHome();

    const run = await createRunRecord({
      homeDir,
      runId: 'run-1',
      profileName: 'default',
      profileHash: 'abc123',
      issueKey: 'ENG-123',
      mutating: false,
      now: new Date('2026-05-10T07:45:09.123Z'),
    });

    expect(run.run_id).toBe('run-1');
    expect(run.status).toBe('initialized');
    expect(run.run_dir).toBe(join(homeDir, '.symphony', 'runs', 'run-1'));

    const parsedRun = JSON.parse(await readFile(join(run.run_dir, 'run.json'), 'utf8')) as { run_id: string };
    const parsedArtifacts = JSON.parse(await readFile(join(run.run_dir, 'artifacts.json'), 'utf8')) as { artifacts: unknown[] };
    const events = await readFile(join(run.run_dir, 'events.jsonl'), 'utf8');

    expect(parsedRun.run_id).toBe('run-1');
    expect(parsedArtifacts.artifacts).toEqual([]);
    expect(events.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(events.trim()).type).toBe('run_created');
    const index = await readFile(join(homeDir, '.symphony', 'runs', 'index.jsonl'), 'utf8');
    expect(index).toContain('run-1');
  });

  it('rejects unsafe run ids before resolving run paths', async () => {
    const homeDir = await tempHome();

    expect(() => runDirForId(homeDir, '../escape')).toThrow('Invalid run id');
    await expect(createRunRecord({ homeDir, runId: '../escape', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: false })).rejects.toThrow('Invalid run id');
  });

  it('updates run.json atomically', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-2', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: true, now: new Date('2026-05-10T07:45:09.123Z') });

    await updateRunJson(run.run_dir, { ...run, status: 'preflight_running' });

    const parsedRun = JSON.parse(await readFile(join(run.run_dir, 'run.json'), 'utf8')) as { status: string };
    expect(parsedRun.status).toBe('preflight_running');
  });

  it('appends complete event lines', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-3', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: true, now: new Date('2026-05-10T07:45:09.123Z') });
    const event: RunEvent = {
      schema_version: 1,
      event_id: 'event-2',
      run_id: 'run-3',
      timestamp: '2026-05-10T07:46:00.000Z',
      type: 'transition',
      data: { from: 'initialized', to: 'preflight_running' },
    };

    await appendEvent(run.run_dir, event);

    const lines = (await readFile(join(run.run_dir, 'events.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toEqual(event);
  });
});
