import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitAdapter } from '../src/supervised/adapters/git.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-git-adapter-'));
}

async function git(repo: string, args: string[]): Promise<void> {
  const adapter = new GitAdapter();
  await adapter.runGit(repo, args);
}

async function createRepo(): Promise<string> {
  const repo = await tempDir();
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

describe('supervised git adapter', () => {
  it('detects normal worktrees and bare repositories', async () => {
    const repo = await createRepo();
    const bare = await tempDir();
    const adapter = new GitAdapter();
    await git(bare, ['init', '--bare']);

    expect(await adapter.isWorktree(repo)).toBe(true);
    expect(await adapter.isBareRepo(repo)).toBe(false);
    expect(await adapter.isBareRepo(bare)).toBe(true);
  });

  it('reads current branch and porcelain status', async () => {
    const repo = await createRepo();
    const adapter = new GitAdapter();
    await writeFile(join(repo, 'new.txt'), 'dirty\n');

    expect(await adapter.currentBranch(repo)).toBe('main');
    expect(await adapter.statusPorcelain(repo)).toContain('?? new.txt');
  });

  it('creates worktrees from a base ref and reports new commits and changed files', async () => {
    const repo = await createRepo();
    const worktree = await tempDir();
    const adapter = new GitAdapter();
    const baseSha = await adapter.revParse(repo, 'HEAD');

    await adapter.createWorktree(repo, worktree, 'feature/test', baseSha);
    await git(worktree, ['config', 'user.name', 'Test User']);
    await git(worktree, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(worktree, 'feature.txt'), 'feature\n');
    await git(worktree, ['add', 'feature.txt']);
    await git(worktree, ['commit', '-m', 'add feature']);

    const commits = await adapter.newCommits(worktree, baseSha, 'HEAD');
    const changed = await adapter.changedFiles(worktree, baseSha, 'HEAD');

    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('add feature');
    expect(changed).toEqual([{ path: 'feature.txt', status: 'A' }]);
  });

  it('reports both old and new paths for renames', async () => {
    const repo = await createRepo();
    const adapter = new GitAdapter();
    const baseSha = await adapter.revParse(repo, 'HEAD');

    await git(repo, ['mv', 'README.md', 'README-renamed.md']);
    await git(repo, ['commit', '-m', 'rename readme']);

    expect(await adapter.changedFiles(repo, baseSha, 'HEAD')).toEqual([
      { status: 'R100', path: 'README-renamed.md', oldPath: 'README.md' },
    ]);
  });

  it('checks branch existence locally and remotely and fetches base sha', async () => {
    const repo = await createRepo();
    const remote = await tempDir();
    const adapter = new GitAdapter();
    await git(remote, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await adapter.pushBranch(repo, 'origin', 'main');
    await adapter.fetchBase(repo, 'origin', 'main');

    expect(await adapter.branchExists(repo, 'main')).toBe(true);
    expect(await adapter.branchExists(repo, 'missing')).toBe(false);
    expect(await adapter.remoteBranchExists(repo, 'origin', 'main')).toBe(true);
    expect(await adapter.remoteBranchExists(repo, 'origin', 'missing')).toBe(false);
    expect(await adapter.remoteBaseSha(repo, 'origin', 'main')).toMatch(/^[a-f0-9]{40}$/);
  });

  it('protects agent worktrees from direct remote pushes while wrapper pushBranch still works', async () => {
    const repo = await createRepo();
    const remote = await tempDir();
    const worktree = await tempDir();
    const adapter = new GitAdapter();
    await git(remote, ['init', '--bare']);
    await git(repo, ['remote', 'add', 'origin', remote]);
    await adapter.pushBranch(repo, 'origin', 'main');
    const baseSha = await adapter.revParse(repo, 'HEAD');
    await adapter.createWorktree(repo, worktree, 'feature/protected', baseSha);
    await adapter.protectWorktreeFromAgentPush(worktree, 'origin');
    await git(worktree, ['config', 'user.name', 'Test User']);
    await git(worktree, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(worktree, 'feature.txt'), 'feature\n');
    await git(worktree, ['add', 'feature.txt']);
    await git(worktree, ['commit', '-m', 'add feature']);

    await expect(adapter.runGit(worktree, ['push', 'origin', 'HEAD:feature/protected'])).rejects.toThrow(/DISABLED_BY_SYMPHONY_AGENT_DO_NOT_PUSH/u);

    await adapter.pushBranch(worktree, 'origin', 'feature/protected');
    expect(await adapter.remoteBranchExists(repo, 'origin', 'feature/protected')).toBe(true);
  });

  it('throws when remote branch existence cannot be checked because the remote is unreadable', async () => {
    const repo = await createRepo();
    const adapter = new GitAdapter();
    await git(repo, ['remote', 'add', 'broken', '/definitely/not/a/repo']);

    await expect(adapter.remoteBranchExists(repo, 'broken', 'feature/nope')).rejects.toThrow();
  });
});
