import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { HooksConfig } from '../workflow/types.js';

export type HookKind = 'after_create' | 'before_run' | 'after_run' | 'before_remove';

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export type WorkspaceError =
  | { code: 'workspace_root_invalid'; message: string }
  | { code: 'workspace_outside_root'; message: string }
  | { code: 'workspace_create_failed'; message: string }
  | { code: 'hook_failed'; hook: HookKind; message: string; exitCode: number | null }
  | { code: 'hook_timeout'; hook: HookKind; message: string };

export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: WorkspaceError };

const WORKSPACE_KEY_REGEX = /[^A-Za-z0-9._-]/g;

/**
 * Sanitize an issue identifier into a safe directory name. Spec §9.5
 * invariant 3: only `[A-Za-z0-9._-]` allowed; everything else → `_`.
 */
export function workspaceKeyFor(identifier: string): string {
  const cleaned = identifier.replace(WORKSPACE_KEY_REGEX, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * Pure path computation. Does NOT touch the filesystem.
 */
export function workspacePathFor(workspaceRoot: string, identifier: string): string {
  const root = path.resolve(workspaceRoot);
  const key = workspaceKeyFor(identifier);
  return path.join(root, key);
}

/**
 * Spec §9.5 invariant 2: workspace_path MUST be under workspace_root, not
 * `==` and no `..` traversal.
 */
export function isInsideRoot(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot);
  const c = path.resolve(candidate);
  if (c === root) return false;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return c.startsWith(rootWithSep);
}

export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  hooks: HooksConfig;
  /** Override for testing. Defaults to spawning bash. */
  hookRunner?: HookRunner;
}

export type HookRunner = (
  hook: HookKind,
  script: string,
  cwd: string,
  timeoutMs: number,
) => Promise<{ ok: true } | { ok: false; error: WorkspaceError }>;

export class WorkspaceManager {
  private readonly root: string;
  private readonly hooks: HooksConfig;
  private readonly runHook: HookRunner;

  constructor(opts: WorkspaceManagerOptions) {
    this.root = path.resolve(opts.workspaceRoot);
    this.hooks = opts.hooks;
    this.runHook = opts.hookRunner ?? defaultBashRunner;
  }

  /**
   * Spec §9.2 — create-or-reuse for one issue. `after_create` fires only on
   * first creation; failure or timeout aborts workspace creation and removes
   * the partially-created directory.
   */
  async createForIssue(identifier: string): Promise<WorkspaceResult<Workspace>> {
    const ensureRoot = this.ensureRootExists();
    if (!ensureRoot.ok) return ensureRoot;

    const workspacePath = workspacePathFor(this.root, identifier);
    if (!isInsideRoot(this.root, workspacePath)) {
      return {
        ok: false,
        error: {
          code: 'workspace_outside_root',
          message: `Computed workspace path ${workspacePath} is not under root ${this.root}`,
        },
      };
    }

    let createdNow = false;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(workspacePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          ok: false,
          error: {
            code: 'workspace_create_failed',
            message: `stat failed for ${workspacePath}: ${(err as Error).message}`,
          },
        };
      }
      try {
        fs.mkdirSync(workspacePath, { recursive: true });
        createdNow = true;
      } catch (mkErr) {
        return {
          ok: false,
          error: {
            code: 'workspace_create_failed',
            message: `mkdir failed for ${workspacePath}: ${(mkErr as Error).message}`,
          },
        };
      }
    }
    if (stat && !stat.isDirectory()) {
      return {
        ok: false,
        error: {
          code: 'workspace_create_failed',
          message: `Workspace path ${workspacePath} exists but is not a directory`,
        },
      };
    }

    if (createdNow && this.hooks.after_create) {
      const hookRes = await this.runHook(
        'after_create',
        this.hooks.after_create,
        workspacePath,
        this.hooks.timeout_ms,
      );
      if (!hookRes.ok) {
        try {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        return hookRes;
      }
    }

    return {
      ok: true,
      value: {
        path: workspacePath,
        workspace_key: workspaceKeyFor(identifier),
        created_now: createdNow,
      },
    };
  }

  /**
   * Spec §9.4 — `before_run` failure or timeout is fatal to the current
   * attempt; caller MUST treat a non-ok result as worker failure.
   */
  async runBeforeRun(workspacePath: string): Promise<WorkspaceResult<true>> {
    if (!this.hooks.before_run) return { ok: true, value: true };
    const res = await this.runHook(
      'before_run',
      this.hooks.before_run,
      workspacePath,
      this.hooks.timeout_ms,
    );
    if (!res.ok) return res;
    return { ok: true, value: true };
  }

  /** Spec §9.4 — `after_run` failure is logged and ignored. */
  async runAfterRun(workspacePath: string): Promise<WorkspaceResult<true>> {
    if (!this.hooks.after_run) return { ok: true, value: true };
    const res = await this.runHook(
      'after_run',
      this.hooks.after_run,
      workspacePath,
      this.hooks.timeout_ms,
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, value: true };
  }

  /**
   * Spec §9 / §8.5 — used during reconciliation when an issue transitions to
   * a terminal state. `before_remove` failure is logged and ignored; cleanup
   * still proceeds.
   */
  async removeForIssue(identifier: string): Promise<WorkspaceResult<true>> {
    const workspacePath = workspacePathFor(this.root, identifier);
    if (!isInsideRoot(this.root, workspacePath)) {
      return {
        ok: false,
        error: {
          code: 'workspace_outside_root',
          message: `Refusing to remove ${workspacePath} (not inside ${this.root})`,
        },
      };
    }
    if (!fs.existsSync(workspacePath)) return { ok: true, value: true };

    if (this.hooks.before_remove) {
      await this.runHook(
        'before_remove',
        this.hooks.before_remove,
        workspacePath,
        this.hooks.timeout_ms,
      );
    }
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'workspace_create_failed',
          message: `rm failed for ${workspacePath}: ${(err as Error).message}`,
        },
      };
    }
    return { ok: true, value: true };
  }

  private ensureRootExists(): WorkspaceResult<true> {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      return { ok: true, value: true };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'workspace_root_invalid',
          message: `Cannot create workspace root ${this.root}: ${(err as Error).message}`,
        },
      };
    }
  }
}

const defaultBashRunner: HookRunner = (hook, script, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn('bash', ['-lc', script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          error: { code: 'hook_timeout', hook, message: `hook ${hook} timed out after ${timeoutMs}ms` },
        });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const tail = stderr.length > 0 ? stderr : stdout;
      resolve({
        ok: false,
        error: {
          code: 'hook_failed',
          hook,
          message: `hook ${hook} exited with code ${code}: ${tail.slice(-2000)}`,
          exitCode: code,
        },
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: {
          code: 'hook_failed',
          hook,
          message: `hook ${hook} failed to spawn: ${err.message}`,
          exitCode: null,
        },
      });
    });
  });
