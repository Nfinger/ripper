import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LinearIssue } from '../src/supervised/adapters/linear.js';
import { appendEvent, createRunRecord, readRunById, updateRunJson } from '../src/supervised/run-record/store.js';
import { transitionRun } from '../src/supervised/run-record/state-machine.js';
import { writeJsonAtomic } from '../src/supervised/storage/atomic.js';
import { readRepoLock } from '../src/supervised/locks/store.js';
import { resumeRealRun, runRealRun, type RealRunClients } from '../src/supervised/run/real-run.js';
import { loadSupervisedProfile } from '../src/supervised/profile/loader.js';

const ISSUE: LinearIssue = { id: 'i1', key: 'ENG-1', title: 'Fix the thing', description: 'body', url: 'https://linear/ENG-1', status: 'Todo', labels: [], assigneeId: null, teamKey: 'ENG', projectName: null, comments: [] };

async function setupHome(profileOverrides: { validationYaml?: string; verificationYaml?: string; prBodyMaxChars?: number; requiredChecksYaml?: string; failureStatus?: string | null } = {}): Promise<{ homeDir: string; repo: string }> {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-real-run-home-'));
  const repo = await mkdtemp(path.join(tmpdir(), 'symphony-real-run-repo-'));
  await writeFile(path.join(repo, 'AGENTS.md'), 'repo guidance');
  await mkdir(path.join(homeDir, '.symphony', 'profiles'), { recursive: true });
  await writeFile(path.join(homeDir, '.symphony', 'profiles', 'p.yaml'), profileYaml(repo, profileOverrides));
  return { homeDir, repo };
}

function clients(overrides: Partial<RealRunClients> = {}): RealRunClients {
  const git = {
    isWorktree: vi.fn(async () => true),
    isBareRepo: vi.fn(async () => false),
    statusPorcelain: vi.fn(async () => ''),
    currentBranch: vi.fn(async () => 'main'),
    fetchBase: vi.fn(async () => undefined),
    branchExists: vi.fn(async () => false),
    remoteBranchExists: vi.fn(async () => false),
    hasMergeOrRebaseInProgress: vi.fn(async () => false),
    remoteBaseSha: vi.fn(async () => 'b'.repeat(40)),
    createWorktree: vi.fn(async (_repoPath: string, worktreePath: string) => {
      await mkdir(path.join(worktreePath, 'src'), { recursive: true });
      await writeFile(path.join(worktreePath, 'src', 'app.ts'), 'export const value = 1;\n');
    }),
    newCommits: vi.fn(async () => [{ sha: 'a'.repeat(40), subject: 'ENG-1 implement thing', body: '', authorName: 'Codex', authorEmail: 'codex@example.com', committerName: 'Codex', committerEmail: 'codex@example.com' }]),
    changedFiles: vi.fn(async () => [{ status: 'A', path: 'src/app.ts' }]),
    pushBranch: vi.fn(async () => undefined),
  };
  const linear = {
    findEligibleIssues: vi.fn(async () => [ISSUE]),
    getIssueByKey: vi.fn(async () => ISSUE),
    checkAuth: vi.fn(async () => ({ ok: true })),
    checkStatus: vi.fn(async () => ({ ok: true })),
    checkAssignee: vi.fn(async () => ({ ok: true })),
    resolveAssigneeId: vi.fn(async () => 'me'),
    claimIssue: vi.fn(async () => undefined),
    updateIssueStatus: vi.fn(async () => undefined),
    postComment: vi.fn(async () => undefined),
    getIssueById: vi.fn()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({ ...ISSUE, status: 'In Progress', assigneeId: 'me' }),
  };
  return {
    git,
    linear,
    github: {
      checkAuth: vi.fn(async () => ({ ok: true })),
      createPullRequest: vi.fn(async () => ({ number: 42, url: 'https://github.com/acme/repo/pull/42' })),
      waitForChecks: vi.fn(async () => ({ ok: true, checks: [{ name: 'backend-tests', bucket: 'pass', state: 'SUCCESS' }] })),
    },
    codexReadiness: { checkAvailable: vi.fn(async () => ({ ok: true, version: '0.129.0' })) },
    codex: { run: vi.fn(async () => ({ ok: true as const, finalText: 'done', exitCode: 0, timedOut: false as const })) },
    reviewer: { run: vi.fn(async () => ({ ok: true as const, finalText: 'Looks good.\n\nAPPROVED', exitCode: 0, timedOut: false as const })) },
    validation: { run: vi.fn(async () => ({ command: 'pnpm', args: ['test'], cwd: '/tmp/worktree', exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 12 })) },
    ...overrides,
  };
}

describe('runRealRun', () => {
  it('claims one issue, runs Codex, gets independent review, checks committed changes, then stops for manual inspection', async () => {
    const { homeDir, repo } = await setupHome();
    const deps = clients();

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps, now: new Date('2026-01-01T00:00:00Z') });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('manual inspection required');
    expect(result.run.status).toBe('code_review_completed');
    expect(result.run.mutating).toBe(true);
    expect(result.run.issue_key).toBe('ENG-1');
    expect(deps.linear.claimIssue).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), assigneeId: 'me' });
    expect(deps.git.createWorktree).toHaveBeenCalledWith(repo, expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')), 'symphony/p/ENG-1-implementation', 'origin/main');
    expect(deps.codex.run).toHaveBeenCalled();
    expect(deps.reviewer.run).toHaveBeenCalled();
    expect(await readFile(path.join(result.run.run_dir, 'agent-review.md'), 'utf8')).toContain('APPROVED');
    expect(deps.git.newCommits).toHaveBeenCalledWith(expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')), 'b'.repeat(40), 'HEAD');
    expect(await readFile(path.join(result.run.run_dir, 'diff-summary.md'), 'utf8')).toContain('ENG-1 implement thing');
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).toContain('Manual inspection required');
    expect(await readRepoLock(homeDir, repo)).toBeNull();
  });

  it('runs validation, pushes the branch, creates a sanitized non-draft PR, waits for CI, then completes Linear success handoff', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Linear handoff complete');
    expect(result.run.status).toBe('succeeded');
    expect(deps.validation.run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'argv', command: 'pnpm', args: ['test'], timeoutMs: 90_000, cwd: expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')) }));
    expect(deps.git.pushBranch).toHaveBeenCalledWith(expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')), 'origin', 'symphony/p/ENG-1-implementation');
    expect(deps.github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      cwd: expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')),
      title: 'ENG-1 Fix the thing',
      head: 'symphony/p/ENG-1-implementation',
      base: 'main',
      draft: false,
    }));
    expect(deps.github.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({
      cwd: expect.stringContaining(path.join(homeDir, '.symphony', 'worktrees')),
      prUrl: 'https://github.com/acme/repo/pull/42',
      requiredOnly: true,
      timeoutMs: 30 * 60_000,
      intervalSeconds: 30,
    }));
    const prBody = (deps.github.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(prBody).toContain('ENG-1');
    expect(prBody).toContain('Validation');
    expect(prBody).not.toContain(homeDir);
    expect(prBody).not.toContain('/tmp/');
    expect(await readFile(path.join(result.run.run_dir, 'validation-summary.md'), 'utf8')).toContain('unit-tests: passed');
    expect(await readFile(path.join(result.run.run_dir, 'pr-body.md'), 'utf8')).not.toContain(homeDir);
    expect(await readFile(path.join(result.run.run_dir, 'ci-summary.md'), 'utf8')).toContain('backend-tests: pass');
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Ready for Review' });
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('Symphony run succeeded'));
    expect(await readFile(path.join(result.run.run_dir, 'linear-success.md'), 'utf8')).toContain('Ready for Review');
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).toContain('Linear handoff complete');
  });

  it('fails safely if Linear success handoff cannot move the issue after CI passes', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();
    deps.linear.updateIssueStatus = vi.fn(async () => { throw new Error('Linear status update failed with /Users/homebase/secret'); });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('linear_handoff_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('linear_handoff_failed'));
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).not.toContain('/Users/homebase/secret');
  });

  it('moves the Linear issue to failure_status when CI fails and failure_status is configured', async () => {
    const { homeDir } = await setupHome({
      failureStatus: 'Needs Attention',
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      github: {
        checkAuth: vi.fn(async () => ({ ok: true })),
        createPullRequest: vi.fn(async () => ({ number: 42, url: 'https://github.com/acme/repo/pull/42' })),
        waitForChecks: vi.fn(async () => ({ ok: false, reason: 'ci_failed' as const, checks: [{ name: 'backend-tests', bucket: 'fail', state: 'FAILURE' }] })),
      },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('ci_failed');
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Needs Attention' });
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('ci_failed'));
  });

  it('redacts GitHub-visible PR title before creating the PR', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const sensitiveIssue = { ...ISSUE, title: 'Fix path /Users/homebase/project/details' };
    const deps = clients();
    deps.linear.findEligibleIssues = vi.fn(async () => [sensitiveIssue]);
    deps.linear.getIssueByKey = vi.fn(async () => sensitiveIssue);
    deps.linear.getIssueById = vi.fn()
      .mockResolvedValueOnce(sensitiveIssue)
      .mockResolvedValueOnce({ ...sensitiveIssue, status: 'In Progress', assigneeId: 'me' });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    const prTitle = (deps.github.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].title;
    expect(prTitle).toContain('ENG-1');
    expect(prTitle).not.toContain('/Users/homebase/project/details');
    expect(prTitle).not.toContain('homebase');
    const prHead = (deps.github.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].head;
    expect(prHead).toBe('symphony/p/ENG-1-implementation');
    expect(prHead).not.toContain('homebase');
  });

  it('moves to failure_status and comments when post-claim verification fails', async () => {
    const { homeDir } = await setupHome({ failureStatus: 'Needs Attention' });
    const deps = clients();
    deps.linear.getIssueById = vi.fn()
      .mockResolvedValueOnce(ISSUE)
      .mockResolvedValueOnce({ ...ISSUE, status: 'Todo', assigneeId: null });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('claim_verification_failed');
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Needs Attention' });
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('claim_verification_failed'));
  });

  it('passes explicit required check names through to GitHub check waiting', async () => {
    const { homeDir } = await setupHome({
      requiredChecksYaml: 'required_checks: { mode: explicit, fallback: [backend-tests, frontend-build] }',
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.github.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({
      requiredOnly: false,
      explicitCheckNames: ['backend-tests', 'frontend-build'],
    }));
  });

  it('autonomously remediates review-requested changes, rechecks the diff, and re-runs review before validation', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      reviewer: { run: vi.fn()
        .mockResolvedValueOnce({ ok: true as const, finalText: 'Blocking issue found\nREQUEST_CHANGES - bug found', exitCode: 0, timedOut: false as const })
        .mockResolvedValueOnce({ ok: true as const, finalText: 'Fixed now\nAPPROVED', exitCode: 0, timedOut: false as const }) },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('succeeded');
    expect(deps.codex.run).toHaveBeenCalledTimes(2);
    expect(deps.reviewer.run).toHaveBeenCalledTimes(2);
    expect(deps.git.newCommits).toHaveBeenCalledTimes(2);
    const remediationPromptPath = (deps.codex.run as ReturnType<typeof vi.fn>).mock.calls[1][0].promptPath;
    expect(remediationPromptPath).toContain('review-remediation-1-prompt.md');
    expect(await readFile(remediationPromptPath, 'utf8')).toContain('REQUEST_CHANGES');
    expect(await readFile(path.join(result.run.run_dir, 'review-remediation-1-final.md'), 'utf8')).toContain('done');
    expect(deps.validation.run).toHaveBeenCalled();
    expect(deps.github.createPullRequest).toHaveBeenCalled();
  });

  it('fails before validation after review remediation attempts are exhausted', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      reviewer: { run: vi.fn(async () => ({ ok: true as const, finalText: 'Still broken\nREQUEST_CHANGES - bug found', exitCode: 0, timedOut: false as const })) },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('code_review_failed');
    expect(deps.codex.run).toHaveBeenCalledTimes(3);
    expect(deps.reviewer.run).toHaveBeenCalledTimes(3);
    expect(deps.validation.run).not.toHaveBeenCalled();
    expect(deps.github.createPullRequest).not.toHaveBeenCalled();
  });

  it('enforces the reviewer final-line approval contract and redacts the shareable review artifact', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({
      reviewer: { run: vi.fn(async () => ({ ok: true as const, finalText: 'Reviewed local repro at /Users/homebase/secret/project\nEverything is NOT APPROVED', exitCode: 0, timedOut: false as const })) },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('code_review_failed');
    expect(result.message).toContain('Agent review failed: code_review_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('code_review_failed'));
    expect(deps.linear.postComment).not.toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
    const review = await readFile(path.join(result.run.run_dir, 'agent-review.md'), 'utf8');
    expect(review).toContain('[REDACTED_LOCAL_PATH]');
    expect(review).not.toContain('/Users/homebase/secret');
  });

  it('fails with code_review_failed without double-transitioning when reviewer returns a failed result', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({
      reviewer: { run: vi.fn(async () => ({ ok: false as const, reason: 'codex_unavailable' as const, exitCode: 1, timedOut: false as const, finalText: '' })) },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('code_review_failed');
    expect(result.message).toContain('Agent review failed: code_review_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('code_review_failed'));
    expect(deps.linear.postComment).not.toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
  });

  it('terminalizes and comments when reviewer execution throws after entering code_review_running', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({ reviewer: { run: vi.fn(async () => { throw new Error('reviewer exploded with /Users/homebase/secret'); }) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('post_claim_unhandled_error');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).not.toContain('/Users/homebase/secret');
  });

  it('runs configured UI Playwright MCP smoke verification before validation and PR handoff', async () => {
    const { homeDir } = await setupHome({
      verificationYaml: `verification:
  enabled: true
  mode: ui_playwright_mcp
  commands:
    - name: playwright-mcp-smoke
      argv: [pnpm, exec, playwright, test, --project=chromium]
      timeout_seconds: 120`,
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    expect(deps.validation.run).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'pnpm', args: ['exec', 'playwright', 'test', '--project=chromium'] }));
    expect(deps.validation.run).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'pnpm', args: ['test'] }));
    expect(await readFile(path.join(result.run.run_dir, 'verification-summary.md'), 'utf8')).toContain('Mode: ui_playwright_mcp');
    const prBody = (deps.github.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(prBody).toContain('Smoke Verification');
  });
  it('terminalizes and comments when smoke verification execution throws after entering verification_running', async () => {
    const { homeDir } = await setupHome({
      verificationYaml: `verification:
  enabled: true
  mode: backend_smoke
  commands:
    - name: backend-smoke
      argv: [pnpm, smoke]
      timeout_seconds: 120`,
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({ validation: { run: vi.fn(async () => { throw new Error('smoke exploded with /Users/homebase/secret'); }) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('post_claim_unhandled_error');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
    expect(deps.github.createPullRequest).not.toHaveBeenCalled();
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).not.toContain('/Users/homebase/secret');
  });


  it('enforces configured maximum PR body length before creating GitHub-visible content', async () => {
    const { homeDir } = await setupHome({
      prBodyMaxChars: 300,
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).toBe(0);
    const prBody = (deps.github.createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(prBody.length).toBeLessThanOrEqual(300);
    expect(prBody).toContain('PR body truncated by Symphony');
    expect(await readFile(path.join(result.run.run_dir, 'pr-body.md'), 'utf8')).toBe(prBody);
  });

  it('fails and comments when CI checks fail after PR creation', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      github: {
        checkAuth: vi.fn(async () => ({ ok: true })),
        createPullRequest: vi.fn(async () => ({ number: 42, url: 'https://github.com/acme/repo/pull/42' })),
        waitForChecks: vi.fn(async () => ({ ok: false, reason: 'ci_failed' as const, checks: [{ name: 'backend-tests', bucket: 'fail', state: 'FAILURE', link: 'https://github.com/acme/repo/actions/runs/1' }] })),
      },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('ci_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('ci_failed'));
    expect(await readFile(path.join(result.run.run_dir, 'ci-summary.md'), 'utf8')).toContain('backend-tests: fail');
  });

  it('times out and comments when CI checks remain pending', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      github: {
        checkAuth: vi.fn(async () => ({ ok: true })),
        createPullRequest: vi.fn(async () => ({ number: 42, url: 'https://github.com/acme/repo/pull/42' })),
        waitForChecks: vi.fn(async () => ({ ok: false, reason: 'ci_timeout' as const, checks: [{ name: 'backend-tests', bucket: 'pending', state: 'PENDING' }] })),
      },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('timed_out');
    expect(run.reason).toBe('ci_timeout');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('ci_timeout'));
    expect(await readFile(path.join(result.run.run_dir, 'ci-summary.md'), 'utf8')).toContain('backend-tests: pending');
  });

  it('fails and comments when PR creation fails after push', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({
      github: {
        checkAuth: vi.fn(async () => ({ ok: true })),
        createPullRequest: vi.fn(async () => { throw new Error('gh pr failed with /Users/homebase/secret'); }),
        waitForChecks: vi.fn(async () => ({ ok: true, checks: [] })),
      },
    });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('pr_creation_failed');
    expect(deps.git.pushBranch).toHaveBeenCalled();
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('pr_creation_failed'));
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).not.toContain('/Users/homebase/secret');
  });

  it('fails and comments after claim when a validation command fails', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({ validation: { run: vi.fn(async () => ({ command: 'pnpm', args: ['test'], cwd: '/tmp/worktree', exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: 'boom', durationMs: 15 })) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('validation_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('validation_failed'));
    expect(await readFile(path.join(result.run.run_dir, 'validation-summary.md'), 'utf8')).toContain('unit-tests: failed');
  });

  it('fails and comments when validation leaves the worktree dirty', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const statusPorcelain = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(' M generated.ts\n');
    const deps = clients({ git: { ...clients().git, statusPorcelain } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('dirty_worktree_after_validation');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('dirty_worktree_after_validation'));
  });

  it('terminalizes and comments when validation execution throws after entering validation_running', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({ validation: { run: vi.fn(async () => { throw new Error('runner exploded'); }) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('post_claim_unhandled_error');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
  });

  it('fails validation when log capture finalization fails', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients({ validation: { run: vi.fn(async () => ({ command: 'pnpm', args: ['test'], cwd: '/tmp/worktree', exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', durationMs: 15, finalizationError: 'log write failed' })) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('validation_failed');
    expect(await readFile(path.join(result.run.run_dir, 'validation-summary.md'), 'utf8')).toContain('unit-tests: failed');
  });

  it('does not claim or run Codex when preflight fails', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({ git: { ...clients().git, statusPorcelain: vi.fn(async () => ' M dirty.ts\n') } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    expect(result.run.status).toBe('preflight_failed');
    expect(deps.linear.claimIssue).not.toHaveBeenCalled();
    expect(deps.codex.run).not.toHaveBeenCalled();
    expect(await readFile(path.join(result.run.run_dir, 'preflight.json'), 'utf8')).toContain('dirty_main_checkout');
  });

  it('fails after claim without validation or handoff when Codex produces no commit', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({ git: { ...clients().git, newCommits: vi.fn(async () => []) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('no_commit');
    expect(deps.linear.claimIssue).toHaveBeenCalled();
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('Symphony run failed after claim'));
    expect(await readFile(path.join(result.run.run_dir, 'linear-failure.md'), 'utf8')).toContain('Reason: no_commit');
  });

  it('terminalizes and comments when a post-claim infrastructure step throws', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({ git: { ...clients().git, remoteBaseSha: vi.fn(async () => { throw new Error('fetch exploded'); }) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('final_fetch_failed');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('final_fetch_failed'));
    expect(deps.codex.run).not.toHaveBeenCalled();
  });

  it('terminalizes and comments when an unexpected post-claim check throws', async () => {
    const { homeDir } = await setupHome();
    const deps = clients({ git: { ...clients().git, changedFiles: vi.fn(async () => { throw new Error('diff exploded'); }) } });

    const result = await runRealRun({ profileName: 'p', homeDir, issueKey: 'ENG-1', clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, result.run.run_id);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('post_claim_unhandled_error');
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('post_claim_unhandled_error'));
  });
  it('resumes a pr_created run by waiting for CI and completing Linear success handoff without rerunning Codex or creating another PR', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();
    const runId = await createResumeFixture(homeDir, 'pr_created');

    const result = await resumeRealRun({ profileName: 'p', homeDir, runId, clients: deps });

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Linear handoff complete');
    expect(result.run.status).toBe('succeeded');
    expect(deps.codex.run).not.toHaveBeenCalled();
    expect(deps.github.createPullRequest).not.toHaveBeenCalled();
    expect(deps.github.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({
      cwd: expect.any(String),
      prUrl: 'https://github.com/acme/repo/pull/42',
      requiredOnly: true,
    }));
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Ready for Review' });
    expect(deps.linear.postComment).toHaveBeenCalledWith('i1', expect.stringContaining('Symphony run succeeded'));
  });

  it('resumes a ci_running run without repeating the ci_running transition', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();
    const runId = await createResumeFixture(homeDir, 'ci_running');

    const result = await resumeRealRun({ profileName: 'p', homeDir, runId, clients: deps });

    expect(result.exitCode).toBe(0);
    expect(result.run.status).toBe('succeeded');
    expect(deps.codex.run).not.toHaveBeenCalled();
    expect(deps.github.createPullRequest).not.toHaveBeenCalled();
    expect(deps.github.waitForChecks).toHaveBeenCalledWith(expect.objectContaining({ prUrl: 'https://github.com/acme/repo/pull/42' }));
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Ready for Review' });
  });

  it('resumes a ci_completed run by only completing the Linear success handoff', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();
    const runId = await createResumeFixture(homeDir, 'ci_completed');

    const result = await resumeRealRun({ profileName: 'p', homeDir, runId, clients: deps });

    expect(result.exitCode).toBe(0);
    expect(result.run.status).toBe('succeeded');
    expect(deps.github.waitForChecks).not.toHaveBeenCalled();
    expect(deps.github.createPullRequest).not.toHaveBeenCalled();
    expect(deps.linear.updateIssueStatus).toHaveBeenCalledWith({ issueId: 'i1', profile: expect.any(Object), statusName: 'Ready for Review' });
  });

  it('resumes a ci_completed run without duplicating an already-completed Linear success handoff', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const runId = await createResumeFixture(homeDir, 'ci_completed');
    const existingComment = [
      'Symphony run succeeded.',
      '',
      'Issue: ENG-1',
      `Run ID: ${runId}`,
      'PR: https://github.com/acme/repo/pull/42',
    ].join('\n');
    const deps = clients();
    deps.linear.getIssueById = vi.fn(async () => ({ ...ISSUE, status: 'Ready for Review', comments: [existingComment] }));
    deps.linear.getIssueByKey = vi.fn(async () => ({ ...ISSUE, status: 'Ready for Review', comments: [existingComment] }));

    const result = await resumeRealRun({ profileName: 'p', homeDir, runId, clients: deps });

    expect(result.exitCode).toBe(0);
    expect(result.run.status).toBe('succeeded');
    expect(deps.github.waitForChecks).not.toHaveBeenCalled();
    expect(deps.linear.updateIssueStatus).not.toHaveBeenCalled();
    expect(deps.linear.postComment).not.toHaveBeenCalled();
    expect(await readFile(path.join(result.run.run_dir, 'result.md'), 'utf8')).toContain('Linear handoff complete');
  });

  it('fails resume safely when a resumable run is missing PR metadata', async () => {
    const { homeDir } = await setupHome({
      validationYaml: `validation:
  network: allowed
  commands:
    - name: unit-tests
      argv: [pnpm, test]
      timeout_seconds: 90`,
    });
    const deps = clients();
    const runId = await createResumeFixture(homeDir, 'pr_created', { writePrJson: false });

    const result = await resumeRealRun({ profileName: 'p', homeDir, runId, clients: deps });

    expect(result.exitCode).not.toBe(0);
    const run = await readRunById(homeDir, runId);
    expect(run.status).toBe('failed');
    expect(run.reason).toBe('resume_integrity_check_failed');
    expect(deps.github.waitForChecks).not.toHaveBeenCalled();
    expect(await readFile(path.join(run.run_dir, 'result.md'), 'utf8')).toContain('resume_integrity_check_failed');
  });

});

async function createResumeFixture(homeDir: string, status: 'pr_created' | 'ci_running' | 'ci_completed', opts: { writePrJson?: boolean } = {}): Promise<string> {
  const loaded = loadSupervisedProfile('p', { homeDir });
  if (loaded.ok === false) throw loaded.error;
  const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: loaded.resolvedHash, issueKey: 'ENG-1', mutating: true, runId: `20260101T000000Z-${status}` });
  await updateRunJson(run.run_dir, { ...run, issue_key: 'ENG-1' });
  await appendEvent(run.run_dir, { schema_version: 1, event_id: 'claim-event', run_id: run.run_id, timestamp: new Date('2026-01-01T00:00:01Z').toISOString(), type: 'side_effect', data: { side_effect: 'linear_issue_claimed', issue_id: 'i1', issue_key: 'ENG-1', assignee_id: 'me', status: 'In Progress' } });
  if (opts.writePrJson !== false) {
    await writeJsonAtomic(path.join(run.run_dir, 'pr.json'), { schema_version: 1, run_id: run.run_id, number: 42, url: 'https://github.com/acme/repo/pull/42', head: 'symphony/p/ENG-1-implementation', base: 'main', draft: false });
  }
  const store = { homeDir };
  await transitionRun(store, run.run_id, 'preflight_running');
  await transitionRun(store, run.run_id, 'candidate_selected');
  await transitionRun(store, run.run_id, 'claimed');
  await transitionRun(store, run.run_id, 'codex_running');
  await transitionRun(store, run.run_id, 'codex_completed');
  await transitionRun(store, run.run_id, 'validation_running');
  await transitionRun(store, run.run_id, 'validation_completed');
  await transitionRun(store, run.run_id, 'handoff_running');
  await transitionRun(store, run.run_id, 'pr_created');
  if (status === 'ci_running' || status === 'ci_completed') await transitionRun(store, run.run_id, 'ci_running');
  if (status === 'ci_completed') await transitionRun(store, run.run_id, 'ci_completed');
  return run.run_id;
}

function profileYaml(repo: string, opts: { validationYaml?: string; verificationYaml?: string; prBodyMaxChars?: number; requiredChecksYaml?: string; failureStatus?: string | null } = {}): string {
  const validationYaml = opts.validationYaml ?? 'validation: { network: allowed, commands: [] }';
  const requiredChecksYaml = opts.requiredChecksYaml ?? 'required_checks: { mode: github_required_checks, fallback: [] }';
  const verificationYaml = opts.verificationYaml ?? 'verification: { enabled: false, mode: generic_smoke, commands: [] }';
  const failureStatus = opts.failureStatus === undefined || opts.failureStatus === null ? 'null' : JSON.stringify(opts.failureStatus);
  return `schema_version: 1
name: p
repo: { path: ${JSON.stringify(repo)}, remote: origin, base_branch: main }
linear:
  team: ENG
  project: null
  eligible_status: Todo
  claim_status: In Progress
  success_status: Ready for Review
  failure_status: ${failureStatus}
  require_unassigned: true
  required_labels: []
  include_comments: true
  max_comments: 20
  comment_order: chronological
  include_attachment_links: true
  download_attachments: false
  comment_max_chars: 8000
  output_tail_max_lines: 80
  assignee: { mode: authenticated_user }
agent: { kind: codex, command: codex, model: gpt-5.5, timeout_minutes: 60, allow_network: true, allow_web_lookup: true, allow_browser_automation: false }
agent_review: { enabled: true, command: codex, model: gpt-5.5, timeout_seconds: 300 }
prompt: { include_repo_instruction_files: [AGENTS.md], repo_instruction_max_chars: 20000, extra_instructions: null }
preflight: { require_main_checkout_clean: true, require_main_checkout_on_base_branch: true, require_no_merge_or_rebase_in_progress: true, require_base_fetchable: true, require_target_branch_absent: true, require_github_auth: true, require_linear_auth: true, require_codex_available: true }
${verificationYaml}
${validationYaml}
change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false }
git: { require_author_email_domains: [], forbid_author_emails: [], author: null }
github:
  create_pr: true
  draft: false
  require_ci_green_before_success: true
  ci_timeout_minutes: 30
  ci_poll_interval_seconds: 30
  ${requiredChecksYaml}
  labels: { best_effort: true, create_missing: false, names: [] }
  reviewers: { users: [], teams: [], best_effort: true }
  assignees: { users: [], best_effort: true }
  pr_body_max_chars: ${opts.prBodyMaxChars ?? 12000}
run: { max_total_minutes: 100 }
cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true }
`;
}
