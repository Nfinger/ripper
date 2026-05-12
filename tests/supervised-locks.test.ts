import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleLocksCommand } from '../src/supervised/commands/locks.js';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_LOCK_EXISTS, EXIT_SUCCEEDED } from '../src/supervised/exit-codes.js';
import { acquireRepoLock, acquireScopedLock, lockPathForRepo, operationLockPathForRepo, releaseRepoLock, releaseScopedLock, readRepoLock, readScopedLock, withScopedOperationLock } from '../src/supervised/locks/store.js';
import { createRunRecord } from '../src/supervised/run-record/store.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-locks-'));
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

describe('supervised repo locks', () => {
  it('acquire lock writes a deterministic lock file for a canonical repo path', async () => {
    const homeDir = await tempHome();
    const repoPath = '/tmp/example-repo';

    const result = await acquireRepoLock({ homeDir, repoPath, runId: 'run-1', reason: 'test', now: new Date('2026-05-10T13:30:00.000Z') });

    expect(result.ok).toBe(true);
    const lock = await readRepoLock(homeDir, repoPath);
    expect(lock?.repo_path).toBe(repoPath);
    expect(lock?.run_id).toBe('run-1');
    expect(lock?.reason).toBe('test');
    expect(lockPathForRepo(homeDir, repoPath)).toMatch(/\.symphony\/locks\/repo-[a-f0-9]{64}\.json$/u);
  });

  it('second acquire fails with lock_exists and preserves the original lock', async () => {
    const homeDir = await tempHome();
    const repoPath = '/tmp/example-repo';
    await acquireRepoLock({ homeDir, repoPath, runId: 'run-1', reason: 'first' });

    const result = await acquireRepoLock({ homeDir, repoPath, runId: 'run-2', reason: 'second' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('lock_exists');
    expect(result.existing?.run_id).toBe('run-1');
    expect((await readRepoLock(homeDir, repoPath))?.run_id).toBe('run-1');
  });

  it('liveness is informational only and stale-looking locks still block acquisition', async () => {
    const homeDir = await tempHome();
    const repoPath = '/tmp/example-repo';
    await acquireRepoLock({ homeDir, repoPath, runId: 'old-run', reason: 'old', now: new Date('2020-01-01T00:00:00.000Z') });

    const result = await acquireRepoLock({ homeDir, repoPath, runId: 'new-run', reason: 'new', now: new Date('2026-05-10T13:30:00.000Z') });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('lock_exists');
    expect(result.existing?.created_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('manual unlock requires reason and writes an audit event when tied to a run', async () => {
    const homeDir = await tempHome();
    const run = await createRunRecord({ homeDir, runId: 'run-lock', profileName: 'default', profileHash: 'abc123', issueKey: null, mutating: true });
    const repoPath = '/tmp/example-repo';
    await acquireRepoLock({ homeDir, repoPath, runId: run.run_id, reason: 'running' });

    await expect(releaseRepoLock({ homeDir, repoPath, reason: '' })).rejects.toThrow('unlock_reason_required');
    const result = await releaseRepoLock({ homeDir, repoPath, reason: 'operator override', runId: run.run_id, now: new Date('2026-05-10T13:35:00.000Z') });

    expect(result.ok).toBe(true);
    expect(await readRepoLock(homeDir, repoPath)).toBeNull();
    const events = await readFile(join(run.run_dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('lock_released');
    expect(events).toContain('operator override');
  });

  it('locks canonical real paths so symlink aliases collide', async () => {
    const homeDir = await tempHome();
    const realRepo = await mkdtemp(join(tmpdir(), 'symphony-lock-real-'));
    const aliasRepo = `${realRepo}-alias`;
    await symlink(realRepo, aliasRepo);

    const first = await acquireRepoLock({ homeDir, repoPath: realRepo, runId: 'real', reason: 'first' });
    const second = await acquireRepoLock({ homeDir, repoPath: aliasRepo, runId: 'alias', reason: 'second' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.existing?.run_id).toBe('real');
  });

  it('recovers stale operation locks whose owner process is gone', async () => {
    const homeDir = await tempHome();
    const repoPath = await mkdtemp(join(tmpdir(), 'symphony-oplock-real-'));
    const opLock = await operationLockPathForRepo(homeDir, repoPath);
    await writeFile(opLock, JSON.stringify({ pid: 99999999, hostname: hostname() }));

    const result = await acquireRepoLock({ homeDir, repoPath, runId: 'run-after-stale-oplock', reason: 'test' });

    expect(result.ok).toBe(true);
  });

  it('refuses to release a scoped lock owned by another run id', async () => {
    const homeDir = await tempHome();
    const scope = 'issue:p:ENG-1';
    await acquireScopedLock({ homeDir, scope, runId: 'run-owner', reason: 'active issue run' });

    const result = await releaseScopedLock({ homeDir, scope, runId: 'run-loser', reason: 'loser cleanup' });

    expect(result.released).toBe(false);
    expect((await readScopedLock(homeDir, scope))?.run_id).toBe('run-owner');
  });

  it('serializes scoped lock release against scoped operations', async () => {
    const homeDir = await tempHome();
    const scope = 'issue:p:ENG-1';
    await acquireScopedLock({ homeDir, scope, runId: 'run-owner', reason: 'active issue run' });
    let releasePromise: Promise<Awaited<ReturnType<typeof releaseScopedLock>>> | undefined;

    await withScopedOperationLock(homeDir, scope, async () => {
      releasePromise = releaseScopedLock({ homeDir, scope, runId: 'run-owner', reason: 'run finished' });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect((await readScopedLock(homeDir, scope))?.run_id).toBe('run-owner');
    });

    await releasePromise;
    expect(await readScopedLock(homeDir, scope)).toBeNull();
  });

  it('locks CLI can inspect and manually release scoped locks', async () => {
    const homeDir = await tempHome();
    const scope = 'issue:p:ENG-1';
    await acquireScopedLock({ homeDir, scope, runId: 'run-scoped-cli', reason: 'test' });
    const statusIo = capture();

    const status = await handleLocksCommand({ argv: ['status', '--scope', scope, '--json'], homeDir, ...statusIo });

    expect(status.exitCode).toBe(EXIT_LOCK_EXISTS);
    expect(JSON.parse(statusIo.stdoutText)).toMatchObject({ locked: true, lock: { run_id: 'run-scoped-cli', scope } });

    const unlockIo = capture();
    const unlock = await handleLocksCommand({ argv: ['unlock', '--scope', scope, '--reason', 'operator override', '--json'], homeDir, ...unlockIo });
    expect(unlock.exitCode).toBe(EXIT_SUCCEEDED);
    expect(JSON.parse(unlockIo.stdoutText)).toEqual({ ok: true, released: true });
    expect(await readScopedLock(homeDir, scope)).toBeNull();
  });

  it('locks CLI supports status and manual unlock with a reason', async () => {
    const homeDir = await tempHome();
    const repoPath = '/tmp/example-repo';
    await acquireRepoLock({ homeDir, repoPath, runId: 'run-cli', reason: 'test' });
    const statusIo = capture();

    const status = await handleLocksCommand({ argv: ['status', repoPath, '--json'], homeDir, ...statusIo });

    expect(status.exitCode).toBe(EXIT_LOCK_EXISTS);
    expect(JSON.parse(statusIo.stdoutText)).toMatchObject({ locked: true, lock: { run_id: 'run-cli' } });

    const missingReasonIo = capture();
    const missingReason = await handleLocksCommand({ argv: ['unlock', repoPath], homeDir, ...missingReasonIo });
    expect(missingReason.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    expect(missingReasonIo.stderrText).toContain('--reason requires a value');

    const unlockIo = capture();
    const unlock = await handleLocksCommand({ argv: ['unlock', repoPath, '--reason', 'operator override', '--json'], homeDir, ...unlockIo });
    expect(unlock.exitCode).toBe(EXIT_SUCCEEDED);
    expect(JSON.parse(unlockIo.stdoutText)).toEqual({ ok: true, released: true });
  });
});
