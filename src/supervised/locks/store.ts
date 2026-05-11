import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, readRunById } from '../run-record/store.js';

export interface RepoLock {
  schema_version: 1;
  lock_id: string;
  repo_path: string;
  repo_hash: string;
  run_id: string | null;
  reason: string;
  created_at: string;
  pid: number;
  hostname: string;
}

export type AcquireLockResult =
  | { ok: true; lock: RepoLock }
  | { ok: false; error: 'lock_exists'; existing: RepoLock | null };

export interface AcquireRepoLockOptions {
  homeDir: string;
  repoPath: string;
  runId?: string | null;
  reason: string;
  now?: Date;
  pid?: number;
  hostname?: string;
}

export interface ReleaseRepoLockOptions {
  homeDir: string;
  repoPath: string;
  reason: string;
  runId?: string | null;
  now?: Date;
}

export interface ReleaseLockResult {
  ok: true;
  released: boolean;
  lock: RepoLock | null;
  auditWritten?: boolean;
}

export async function acquireRepoLock(opts: AcquireRepoLockOptions): Promise<AcquireLockResult> {
  const canonicalRepoPath = await canonicalRepoPathForLock(opts.repoPath);
  return withRepoOperationLock(opts.homeDir, canonicalRepoPath, async () => {
    const lockPath = lockPathForRepo(opts.homeDir, canonicalRepoPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const reason = opts.reason.trim();
    if (!reason) throw new Error('lock_reason_required');
    const lock = buildLock({ ...opts, repoPath: canonicalRepoPath, reason });
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      await handle.sync();
      await fsyncDirectory(path.dirname(lockPath));
      return { ok: true, lock };
    } catch (error) {
      if (isFileExistsError(error)) {
        return { ok: false, error: 'lock_exists', existing: await readRepoLockByCanonicalPath(opts.homeDir, canonicalRepoPath) };
      }
      throw error;
    } finally {
      await handle?.close();
    }
  });
}

export async function readRepoLock(homeDir: string, repoPath: string): Promise<RepoLock | null> {
  return readRepoLockByCanonicalPath(homeDir, await canonicalRepoPathForLock(repoPath));
}

async function readRepoLockByCanonicalPath(homeDir: string, canonicalRepoPath: string): Promise<RepoLock | null> {
  try {
    return JSON.parse(await readFile(lockPathForRepo(homeDir, canonicalRepoPath), 'utf8')) as RepoLock;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function releaseRepoLock(opts: ReleaseRepoLockOptions): Promise<ReleaseLockResult> {
  const canonicalRepoPath = await canonicalRepoPathForLock(opts.repoPath);
  return withRepoOperationLock(opts.homeDir, canonicalRepoPath, async () => {
    const reason = opts.reason.trim();
    if (!reason) throw new Error('unlock_reason_required');
    const lock = await readRepoLockByCanonicalPath(opts.homeDir, canonicalRepoPath);
    if (!lock) return { ok: true, released: false, lock: null };
    await rm(lockPathForRepo(opts.homeDir, canonicalRepoPath));
    await fsyncDirectory(path.dirname(lockPathForRepo(opts.homeDir, canonicalRepoPath)));
    const runId = opts.runId ?? lock.run_id;
    let auditWritten = false;
    if (runId) {
      try {
        const run = await readRunById(opts.homeDir, runId);
        await appendEvent(run.run_dir, {
          schema_version: 1,
          event_id: randomUUID(),
          run_id: runId,
          timestamp: (opts.now ?? new Date()).toISOString(),
          type: 'side_effect',
          data: { side_effect: 'lock_released', repo_path: canonicalRepoPath, reason, lock_id: lock.lock_id },
        });
        auditWritten = true;
      } catch {
        // Missing/corrupt historical run records are non-fatal for manual recovery.
      }
    }
    return { ok: true, released: true, lock, auditWritten };
  });
}

export function locksDir(homeDir: string): string {
  return path.join(homeDir, '.symphony', 'locks');
}

export function lockPathForRepo(homeDir: string, repoPath: string): string {
  return path.join(locksDir(homeDir), `repo-${repoHash(repoPath)}.json`);
}

export async function operationLockPathForRepo(homeDir: string, repoPath: string): Promise<string> {
  await mkdir(locksDir(homeDir), { recursive: true });
  return path.join(locksDir(homeDir), `repo-${repoHash(await canonicalRepoPathForLock(repoPath))}.oplock`);
}

export function repoHash(repoPath: string): string {
  return createHash('sha256').update(path.resolve(repoPath)).digest('hex');
}

function buildLock(opts: AcquireRepoLockOptions): RepoLock {
  const repoPath = path.resolve(opts.repoPath);
  return {
    schema_version: 1,
    lock_id: randomUUID(),
    repo_path: repoPath,
    repo_hash: repoHash(repoPath),
    run_id: opts.runId ?? null,
    reason: opts.reason,
    created_at: (opts.now ?? new Date()).toISOString(),
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname ?? os.hostname(),
  };
}

async function canonicalRepoPathForLock(repoPath: string): Promise<string> {
  const resolved = path.resolve(repoPath);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (isNotFoundError(error)) return resolved;
    throw error;
  }
}

async function withRepoOperationLock<T>(homeDir: string, canonicalRepoPath: string, fn: () => Promise<T>): Promise<T> {
  const lockDirectory = locksDir(homeDir);
  await mkdir(lockDirectory, { recursive: true });
  const opLockPath = path.join(lockDirectory, `repo-${repoHash(canonicalRepoPath)}.oplock`);
  let handle;
  try {
    handle = await open(opLockPath, 'wx', 0o600);
  } catch (error) {
    if (isFileExistsError(error)) {
      if (await removeStaleOperationLock(opLockPath)) {
        handle = await open(opLockPath, 'wx', 0o600);
      } else {
        throw new Error('lock_operation_in_progress');
      }
    } else {
      throw error;
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: os.hostname(), created_at: new Date().toISOString() })}\n`, 'utf8');
    await handle.sync();
    return await fn();
  } finally {
    await handle.close();
    try {
      await rm(opLockPath);
      await fsyncDirectory(lockDirectory);
    } catch {
      // Best-effort cleanup for transient operation lock files.
    }
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is best-effort across platforms/filesystems.
  } finally {
    await handle?.close();
  }
}

async function removeStaleOperationLock(opLockPath: string): Promise<boolean> {
  try {
    const raw = (await readFile(opLockPath, 'utf8')).trim();
    const parsed = parseOperationLock(raw);
    if (!parsed || parsed.hostname !== os.hostname()) return false;
    if (isPidAlive(parsed.pid)) return false;
    await rm(opLockPath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return true;
    return false;
  }
}

function parseOperationLock(raw: string): { pid: number; hostname: string } | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; hostname?: unknown };
    if (typeof parsed.pid === 'number' && typeof parsed.hostname === 'string') return { pid: parsed.pid, hostname: parsed.hostname };
  } catch {
    const pid = Number(raw);
    if (Number.isInteger(pid)) return { pid, hostname: os.hostname() };
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
