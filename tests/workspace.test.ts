import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type HookRunner,
  WorkspaceManager,
  isInsideRoot,
  workspaceKeyFor,
  workspacePathFor,
} from '../src/workspace/manager.js';
import type { HooksConfig } from '../src/workflow/types.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-ws-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const noHooks: HooksConfig = {
  after_create: null,
  before_run: null,
  after_run: null,
  before_remove: null,
  timeout_ms: 5000,
};

const passHookRunner: HookRunner = async () => ({ ok: true });

describe('workspaceKeyFor', () => {
  it('preserves alphanumerics and ._-', () => {
    expect(workspaceKeyFor('MS-101')).toBe('MS-101');
    expect(workspaceKeyFor('A.b_c-1')).toBe('A.b_c-1');
  });

  it('replaces unsafe characters with underscore', () => {
    expect(workspaceKeyFor('foo bar')).toBe('foo_bar');
    expect(workspaceKeyFor('foo/bar')).toBe('foo_bar');
    expect(workspaceKeyFor('a/b/../etc')).toBe('a_b_.._etc');
    expect(workspaceKeyFor('weird $!')).toBe('weird___');
  });

  it('returns underscore for empty input', () => {
    expect(workspaceKeyFor('')).toBe('_');
  });
});

describe('workspacePathFor + isInsideRoot', () => {
  it('places workspace under sanitized identifier', () => {
    const p = workspacePathFor('/tmp/sym', 'MS-101');
    expect(p).toBe(path.resolve('/tmp/sym/MS-101'));
  });

  it('blocks paths outside root', () => {
    expect(isInsideRoot('/tmp/sym', '/tmp/sym/MS-101')).toBe(true);
    expect(isInsideRoot('/tmp/sym', '/tmp/other')).toBe(false);
    expect(isInsideRoot('/tmp/sym', '/tmp/sym')).toBe(false);
    expect(isInsideRoot('/tmp/sym', '/tmp/symbol')).toBe(false);
  });
});

describe('WorkspaceManager', () => {
  it('creates a new workspace and reports created_now=true', async () => {
    const m = new WorkspaceManager({ workspaceRoot: tmpRoot, hooks: noHooks });
    const res = await m.createForIssue('MS-101');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.path).toBe(path.join(tmpRoot, 'MS-101'));
      expect(res.value.workspace_key).toBe('MS-101');
      expect(res.value.created_now).toBe(true);
    }
    expect(fs.statSync(path.join(tmpRoot, 'MS-101')).isDirectory()).toBe(true);
  });

  it('reuses an existing workspace and reports created_now=false', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'MS-101'));
    const m = new WorkspaceManager({ workspaceRoot: tmpRoot, hooks: noHooks });
    const res = await m.createForIssue('MS-101');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.created_now).toBe(false);
  });

  it('runs after_create only on new workspace', async () => {
    let calls = 0;
    const runner: HookRunner = async (hook) => {
      if (hook === 'after_create') calls++;
      return { ok: true };
    };
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, after_create: 'echo hi' },
      hookRunner: runner,
    });
    await m.createForIssue('MS-1');
    expect(calls).toBe(1);
    await m.createForIssue('MS-1');
    expect(calls).toBe(1);
  });

  it('aborts and removes the directory when after_create fails', async () => {
    const runner: HookRunner = async () => ({
      ok: false,
      error: { code: 'hook_failed', hook: 'after_create', message: 'boom', exitCode: 1 },
    });
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, after_create: 'exit 1' },
      hookRunner: runner,
    });
    const res = await m.createForIssue('MS-2');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('hook_failed');
    expect(fs.existsSync(path.join(tmpRoot, 'MS-2'))).toBe(false);
  });

  it('refuses to create a workspace whose computed path leaks the root', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'MS-3'), 'i am a file not a dir');
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: noHooks,
      hookRunner: passHookRunner,
    });
    const res = await m.createForIssue('MS-3');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('workspace_create_failed');
  });

  it('runBeforeRun aborts on failure', async () => {
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, before_run: 'do something' },
      hookRunner: async () => ({
        ok: false,
        error: { code: 'hook_failed', hook: 'before_run', message: 'boom', exitCode: 1 },
      }),
    });
    const ws = await m.createForIssue('MS-4');
    expect(ws.ok).toBe(true);
    if (!ws.ok) return;
    const res = await m.runBeforeRun(ws.value.path);
    expect(res.ok).toBe(false);
  });

  it('runAfterRun surfaces failure but does not throw (caller logs and ignores)', async () => {
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, after_run: 'do something' },
      hookRunner: async () => ({
        ok: false,
        error: { code: 'hook_failed', hook: 'after_run', message: 'boom', exitCode: 1 },
      }),
    });
    const ws = await m.createForIssue('MS-5');
    if (!ws.ok) throw new Error('setup failed');
    const res = await m.runAfterRun(ws.value.path);
    expect(res.ok).toBe(false);
  });

  it('removeForIssue is a no-op when the directory does not exist', async () => {
    const m = new WorkspaceManager({ workspaceRoot: tmpRoot, hooks: noHooks });
    const res = await m.removeForIssue('NEVER-CREATED');
    expect(res.ok).toBe(true);
  });

  it('removeForIssue runs before_remove and then deletes', async () => {
    let beforeRemoveCalled = false;
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, before_remove: 'echo bye' },
      hookRunner: async (hook) => {
        if (hook === 'before_remove') beforeRemoveCalled = true;
        return { ok: true };
      },
    });
    await m.createForIssue('MS-6');
    expect(fs.existsSync(path.join(tmpRoot, 'MS-6'))).toBe(true);
    const res = await m.removeForIssue('MS-6');
    expect(res.ok).toBe(true);
    expect(beforeRemoveCalled).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'MS-6'))).toBe(false);
  });

  it('removeForIssue still deletes when before_remove fails', async () => {
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, before_remove: 'exit 1' },
      hookRunner: async () => ({
        ok: false,
        error: { code: 'hook_failed', hook: 'before_remove', message: 'boom', exitCode: 1 },
      }),
    });
    await m.createForIssue('MS-7');
    const res = await m.removeForIssue('MS-7');
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'MS-7'))).toBe(false);
  });
});

describe('WorkspaceManager hook runner default (real bash)', () => {
  it('runs a real bash hook and reports failure when it exits non-zero', async () => {
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, after_create: 'echo hello && exit 7' },
    });
    const res = await m.createForIssue('REAL-1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('hook_failed');
      if (res.error.code === 'hook_failed') expect(res.error.exitCode).toBe(7);
    }
  });

  it('enforces hook timeout', async () => {
    const m = new WorkspaceManager({
      workspaceRoot: tmpRoot,
      hooks: { ...noHooks, after_create: 'sleep 10', timeout_ms: 200 },
    });
    const res = await m.createForIssue('SLEEPER');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('hook_timeout');
  });
});
