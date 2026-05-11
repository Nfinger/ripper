import { describe, expect, it, vi } from 'vitest';
import { GitHubCliAdapter } from '../src/supervised/adapters/github.js';
import type { RunCommandOptions } from '../src/supervised/command-runner/types.js';

describe('GitHubCliAdapter', () => {
  it('creates a PR using supported gh commands and returns structured PR metadata', async () => {
    const calls: RunCommandOptions[] = [];
    const commandRunner = vi.fn(async (opts: RunCommandOptions) => {
      calls.push(opts);
      if (opts.mode === 'argv' && opts.args[0] === 'pr' && opts.args[1] === 'create') {
        return { command: opts.command, args: opts.args, cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: 'https://github.com/acme/repo/pull/42\n', stderr: '', durationMs: 20 };
      }
      if (opts.mode === 'argv' && opts.args[0] === 'pr' && opts.args[1] === 'view') {
        return { command: opts.command, args: opts.args, cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '{"number":42,"url":"https://github.com/acme/repo/pull/42"}\n', stderr: '', durationMs: 20 };
      }
      throw new Error(`unexpected command: ${JSON.stringify(opts)}`);
    });
    const adapter = new GitHubCliAdapter({ commandRunner });

    const result = await adapter.createPullRequest({ cwd: '/repo', title: 'ENG-1 Fix', body: 'body', head: 'branch', base: 'main', draft: false });

    expect(result).toEqual({ number: 42, url: 'https://github.com/acme/repo/pull/42' });
    expect(calls[0]).toMatchObject({ mode: 'argv', command: 'gh', cwd: '/repo' });
    expect(calls[0]?.mode === 'argv' ? calls[0].args : []).toEqual(['pr', 'create', '--title', 'ENG-1 Fix', '--body', 'body', '--head', 'branch', '--base', 'main']);
    expect(calls[0]?.mode === 'argv' ? calls[0].args : []).not.toContain('--json');
    expect(calls[1]).toMatchObject({ mode: 'argv', command: 'gh', cwd: '/repo' });
    expect(calls[1]?.mode === 'argv' ? calls[1].args : []).toEqual(['pr', 'view', 'https://github.com/acme/repo/pull/42', '--json', 'number,url']);
  });

  it('falls back to PR number from created URL when gh pr view cannot return metadata', async () => {
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => {
      if (opts.mode === 'argv' && opts.args[1] === 'create') return { command: opts.command, args: opts.args, cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: 'https://github.com/acme/repo/pull/42\n', stderr: '', durationMs: 20 };
      return { command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: 'api unavailable', durationMs: 20 };
    }) });

    await expect(adapter.createPullRequest({ cwd: '/repo', title: 'ENG-1 Fix', body: 'body', head: 'branch', base: 'main', draft: false })).resolves.toEqual({ number: 42, url: 'https://github.com/acme/repo/pull/42' });
  });

  it('adds --draft only when requested', async () => {
    const calls: RunCommandOptions[] = [];
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => {
      calls.push(opts);
      if (opts.mode === 'argv' && opts.args[1] === 'create') return { command: opts.command, args: opts.args, cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: 'https://github.com/acme/repo/pull/42\n', stderr: '', durationMs: 20 };
      return { command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '{"number":42,"url":"https://github.com/acme/repo/pull/42"}\n', stderr: '', durationMs: 20 };
    }) });

    await adapter.createPullRequest({ cwd: '/repo', title: 'ENG-1 Fix', body: 'body', head: 'branch', base: 'main', draft: true });

    expect(calls[0]?.mode === 'argv' ? calls[0].args : []).toContain('--draft');
  });

  it('waits for required PR checks with gh watch and parses passing check metadata', async () => {
    const calls: RunCommandOptions[] = [];
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => {
      calls.push(opts);
      return { command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '[{"name":"backend-tests","state":"SUCCESS","bucket":"pass","link":"https://github.com/acme/repo/actions/runs/1"}]', stderr: '', durationMs: 20 };
    }) });

    const result = await adapter.waitForChecks({ cwd: '/repo', prUrl: 'https://github.com/acme/repo/pull/42', requiredOnly: true, timeoutMs: 60000, intervalSeconds: 10 });

    expect(result).toEqual({ ok: true, checks: [{ name: 'backend-tests', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/acme/repo/actions/runs/1' }] });
    expect(calls[0]?.mode === 'argv' ? calls[0].args : []).toEqual(['pr', 'checks', 'https://github.com/acme/repo/pull/42', '--watch', '--fail-fast', '--interval', '10', '--json', 'name,state,bucket,link,workflow', '--required']);
  });

  it('maps timed out PR checks to ci_timeout', async () => {
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 124, signal: null, timedOut: true, stdout: '[{"name":"backend-tests","state":"PENDING","bucket":"pending"}]', stderr: '', durationMs: 60000 })) });

    await expect(adapter.waitForChecks({ cwd: '/repo', prUrl: 'https://github.com/acme/repo/pull/42', requiredOnly: true, timeoutMs: 60000, intervalSeconds: 10 })).resolves.toEqual({ ok: false, reason: 'ci_timeout', checks: [{ name: 'backend-tests', state: 'PENDING', bucket: 'pending' }] });
  });

  it('does not treat invalid check JSON as CI success', async () => {
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: 'not-json', stderr: '', durationMs: 20 })) });

    await expect(adapter.waitForChecks({ cwd: '/repo', prUrl: 'https://github.com/acme/repo/pull/42', requiredOnly: true, timeoutMs: 60000, intervalSeconds: 10 })).resolves.toMatchObject({ ok: false, reason: 'ci_failed' });
  });

  it('enforces explicit required check names and ignores unrelated optional failures', async () => {
    const calls: RunCommandOptions[] = [];
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => {
      calls.push(opts);
      return {
        command: opts.command,
        args: opts.mode === 'argv' ? opts.args : [],
        cwd: opts.cwd,
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '[{"name":"backend-tests","state":"SUCCESS","bucket":"pass"},{"name":"optional-lint","state":"FAILURE","bucket":"fail"}]',
        stderr: '',
        durationMs: 20,
      };
    }) });

    await expect(adapter.waitForChecks({ cwd: '/repo', prUrl: 'https://github.com/acme/repo/pull/42', requiredOnly: false, explicitCheckNames: ['backend-tests'], timeoutMs: 60000, intervalSeconds: 10 })).resolves.toEqual({ ok: true, checks: [{ name: 'backend-tests', state: 'SUCCESS', bucket: 'pass' }] });
    expect(calls[0]?.mode === 'argv' ? calls[0].args : []).not.toContain('--fail-fast');
  });

  it('fails when an explicitly required check is missing from gh output', async () => {
    const adapter = new GitHubCliAdapter({ commandRunner: vi.fn(async (opts: RunCommandOptions) => ({ command: opts.command, args: opts.mode === 'argv' ? opts.args : [], cwd: opts.cwd, exitCode: 0, signal: null, timedOut: false, stdout: '[{"name":"backend-tests","state":"SUCCESS","bucket":"pass"}]', stderr: '', durationMs: 20 })) });

    await expect(adapter.waitForChecks({ cwd: '/repo', prUrl: 'https://github.com/acme/repo/pull/42', requiredOnly: false, explicitCheckNames: ['backend-tests', 'frontend-build'], timeoutMs: 60000, intervalSeconds: 10 })).resolves.toEqual({ ok: false, reason: 'ci_failed', checks: [{ name: 'backend-tests', state: 'SUCCESS', bucket: 'pass' }, { name: 'frontend-build', state: 'missing', bucket: 'fail' }] });
  });
});
