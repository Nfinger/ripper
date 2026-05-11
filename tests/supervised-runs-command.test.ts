import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleRunsCommand } from '../src/supervised/commands/runs.js';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_SUCCEEDED } from '../src/supervised/exit-codes.js';
import { createRunRecord, updateRunJson } from '../src/supervised/run-record/store.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-runs-command-'));
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    get stdoutText() {
      return stdout;
    },
    get stderrText() {
      return stderr;
    },
  };
}

describe('handleRunsCommand', () => {
  it('runs show <run_id> reads run.json', async () => {
    const homeDir = await tempHome();
    await createRunRecord({ homeDir, runId: 'run-show', profileName: 'default', profileHash: 'abc123', issueKey: 'ENG-123', mutating: true });
    const io = capture();

    const result = await handleRunsCommand({ argv: ['show', 'run-show', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    const parsed = JSON.parse(io.stdoutText) as { run: { run_id: string; issue_key: string } };
    expect(parsed.run.run_id).toBe('run-show');
    expect(parsed.run.issue_key).toBe('ENG-123');
  });

  it('runs list uses index.jsonl when present', async () => {
    const homeDir = await tempHome();
    const symphonyDir = join(homeDir, '.symphony', 'runs');
    await mkdir(symphonyDir, { recursive: true });
    await writeFile(join(symphonyDir, 'index.jsonl'), `${JSON.stringify({ run_id: 'from-index', status: 'succeeded', updated_at: '2026-05-10T07:46:00.000Z' })}\n`);
    const io = capture();

    const result = await handleRunsCommand({ argv: ['list', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    const parsed = JSON.parse(io.stdoutText) as { runs: Array<{ run_id: string }> };
    expect(parsed.runs).toEqual([{ run_id: 'from-index', status: 'succeeded', updated_at: '2026-05-10T07:46:00.000Z' }]);
  });

  it('runs rebuild-index scans run directories and backs up old index', async () => {
    const homeDir = await tempHome();
    const symphonyDir = join(homeDir, '.symphony', 'runs');
    await mkdir(symphonyDir, { recursive: true });
    await createRunRecord({ homeDir, runId: 'run-a', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: false });
    await createRunRecord({ homeDir, runId: 'run-b', profileName: 'default', profileHash: 'abc123', issueKey: 'ENG-2', mutating: true });
    await writeFile(join(symphonyDir, 'index.jsonl'), 'old\n');
    const io = capture();

    const result = await handleRunsCommand({ argv: ['rebuild-index'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    const index = await readFile(join(symphonyDir, 'index.jsonl'), 'utf8');
    expect(index).toContain('run-a');
    expect(index).toContain('run-b');
    expect(await readFile(join(symphonyDir, 'index.jsonl.bak'), 'utf8')).toBe('old\n');
  });

  it('runs verify <run_id> catches missing result.md for terminal states', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-terminal', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: false });
    await updateRunJson(run.run_dir, { ...run, status: 'failed', reason: 'validation_failed' });
    const io = capture();

    const result = await handleRunsCommand({ argv: ['verify', 'run-terminal', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    const parsed = JSON.parse(io.stdoutText) as { ok: boolean; errors: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toContain('missing_result_md_for_terminal_state');
  });

  it('runs verify <run_id> succeeds when terminal result.md and JSONL are valid', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-ok', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: false });
    await updateRunJson(run.run_dir, { ...run, status: 'failed', reason: 'validation_failed' });
    await writeFile(join(run.run_dir, 'result.md'), '# Result\n');
    const io = capture();

    const result = await handleRunsCommand({ argv: ['verify', 'run-ok', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    expect(JSON.parse(io.stdoutText)).toEqual({ ok: true, errors: [] });
  });

  it('runs show rejects unsafe run ids', async () => {
    const homeDir = await tempHome();
    const io = capture();

    const result = await handleRunsCommand({ argv: ['show', '../escape', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    expect(io.stderrText).toContain('Invalid run id');
  });
});
