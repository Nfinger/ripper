import { access } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../command-runner/runner.js';

export interface CommitInfo {
  sha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  oldPath?: string;
}

export class GitAdapter {
  async runGit(cwd: string, args: string[]): Promise<string> {
    const result = await runCommand({ mode: 'argv', command: 'git', args, cwd, timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`.trim());
    }
    return result.stdout;
  }

  async isWorktree(repoPath: string): Promise<boolean> {
    return (await this.gitBool(repoPath, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  async isBareRepo(repoPath: string): Promise<boolean> {
    return (await this.gitBool(repoPath, ['rev-parse', '--is-bare-repository'])) === 'true';
  }

  async currentBranch(repoPath: string): Promise<string> {
    return (await this.runGit(repoPath, ['branch', '--show-current'])).trim();
  }

  async statusPorcelain(repoPath: string): Promise<string> {
    return this.runGit(repoPath, ['status', '--porcelain']);
  }

  async revParse(repoPath: string, ref: string): Promise<string> {
    return (await this.runGit(repoPath, ['rev-parse', ref])).trim();
  }

  async remoteBaseSha(repoPath: string, remote: string, base: string): Promise<string> {
    return this.revParse(repoPath, `${remote}/${base}`);
  }

  async gitDir(repoPath: string): Promise<string> {
    const output = (await this.runGit(repoPath, ['rev-parse', '--git-dir'])).trim();
    return path.isAbsolute(output) ? output : path.join(repoPath, output);
  }

  async hasMergeOrRebaseInProgress(repoPath: string): Promise<boolean> {
    const gitDir = await this.gitDir(repoPath);
    const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'];
    for (const marker of markers) {
      try {
        await access(path.join(gitDir, marker));
        return true;
      } catch {
        // Continue checking other markers.
      }
    }
    return false;
  }

  async fetchBase(repoPath: string, remote: string, base: string): Promise<void> {
    await this.runGit(repoPath, ['fetch', remote, base]);
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    return this.gitSucceeds(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  }

  async remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean> {
    const result = await runCommand({ mode: 'argv', command: 'git', args: ['ls-remote', '--exit-code', '--heads', remote, branch], cwd: repoPath, timeoutMs: 30_000 });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    throw new Error(`git ls-remote failed: ${result.stderr || result.stdout}`.trim());
  }

  async createWorktree(repoPath: string, worktreePath: string, branch: string, baseRef: string): Promise<void> {
    await this.runGit(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  }

  async protectWorktreeFromAgentPush(worktreePath: string, remote: string): Promise<void> {
    await this.runGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
    await this.runGit(worktreePath, ['config', '--worktree', 'push.default', 'nothing']);
    await this.runGit(worktreePath, ['config', '--worktree', `remote.${remote}.pushurl`, 'DISABLED_BY_SYMPHONY_AGENT_DO_NOT_PUSH']);
  }

  async newCommits(repoPath: string, baseSha: string, headRef: string): Promise<CommitInfo[]> {
    const output = await this.runGit(repoPath, ['log', '--format=%H%x1f%s%x1f%B%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1e', `${baseSha}..${headRef}`]);
    return output
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [sha = '', subject = '', body = '', authorName = '', authorEmail = '', committerName = '', committerEmail = ''] = entry.split('\x1f');
        return { sha, subject, body, authorName, authorEmail, committerName, committerEmail };
      });
  }

  async changedFiles(repoPath: string, baseSha: string, headRef: string): Promise<ChangedFile[]> {
    const output = await this.runGit(repoPath, ['diff', '--name-status', '-z', `${baseSha}..${headRef}`]);
    const parts = output.split('\0').filter((part) => part.length > 0);
    const files: ChangedFile[] = [];
    for (let index = 0; index < parts.length;) {
      const status = parts[index++] ?? '';
      const firstPath = parts[index++] ?? '';
      if ((status.startsWith('R') || status.startsWith('C')) && index < parts.length) {
        const secondPath = parts[index++] ?? '';
        files.push({ status, path: secondPath, oldPath: firstPath });
      } else {
        files.push({ status, path: firstPath });
      }
    }
    return files;
  }

  async pushBranch(worktreePath: string, remote: string, branch: string): Promise<void> {
    const remoteUrl = (await this.runGit(worktreePath, ['remote', 'get-url', remote])).trim();
    await this.runGit(worktreePath, ['push', remoteUrl, `${branch}:${branch}`]);
  }

  private async gitBool(cwd: string, args: string[]): Promise<string> {
    try {
      return (await this.runGit(cwd, args)).trim();
    } catch {
      return 'false';
    }
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    const result = await runCommand({ mode: 'argv', command: 'git', args, cwd, timeoutMs: 30_000 });
    return result.exitCode === 0;
  }
}
