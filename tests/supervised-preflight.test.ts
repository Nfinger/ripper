import { describe, expect, it } from 'vitest';
import { runPreflight, type CodexPreflightClient, type GitHubPreflightClient, type GitPreflightClient, type LinearPreflightClient } from '../src/supervised/run/preflight.js';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';

function profile(overrides: Partial<SupervisedProfile['preflight']> = {}): SupervisedProfile {
  return {
    schema_version: 1,
    name: 'p',
    repo: { path: '/tmp/repo', remote: 'origin', base_branch: 'main' },
    linear: {
      team: 'ENG', project: null, eligible_status: 'Todo', claim_status: 'In Progress', success_status: 'Done', failure_status: null,
      require_unassigned: true, required_labels: [], include_comments: true, max_comments: 20, comment_order: 'chronological',
      include_attachment_links: true, download_attachments: false, comment_max_chars: 8000, output_tail_max_lines: 80,
      assignee: { mode: 'authenticated_user' },
    },
    agent: { kind: 'codex', command: 'codex', model: null, min_version: '0.129.0', timeout_minutes: 60, allow_network: true, allow_web_lookup: true, allow_browser_automation: false },
    prompt: { include_repo_instruction_files: [], repo_instruction_max_chars: 1000, extra_instructions: null },
    preflight: {
      require_main_checkout_clean: true,
      require_main_checkout_on_base_branch: true,
      require_no_merge_or_rebase_in_progress: true,
      require_base_fetchable: true,
      require_target_branch_absent: true,
      require_github_auth: true,
      require_linear_auth: true,
      require_codex_available: true,
      ...overrides,
    },
    validation: { network: 'allowed', commands: [] },
    change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1_000_000, allow_binary_files: false },
    git: { require_author_email_domains: [], forbid_author_emails: [], author: null },
    github: { create_pr: true, draft: false, require_ci_green_before_success: true, ci_timeout_minutes: 30, ci_poll_interval_seconds: 30, required_checks: { mode: 'github_required_checks', fallback: [] }, labels: { best_effort: true, create_missing: false, names: [] }, reviewers: { users: [], teams: [], best_effort: true }, assignees: { users: [], best_effort: true }, pr_body_max_chars: 12000 },
    run: { max_total_minutes: 100 },
    cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true },
  };
}

function okGit(overrides: Partial<GitPreflightClient> = {}): GitPreflightClient {
  return {
    isWorktree: async () => true,
    isBareRepo: async () => false,
    statusPorcelain: async () => '',
    currentBranch: async () => 'main',
    fetchBase: async () => undefined,
    branchExists: async () => false,
    remoteBranchExists: async () => false,
    hasMergeOrRebaseInProgress: async () => false,
    ...overrides,
  };
}

function okGithub(overrides: Partial<GitHubPreflightClient> = {}): GitHubPreflightClient {
  return { checkAuth: async () => ({ ok: true }), ...overrides };
}

function okLinear(overrides: Partial<LinearPreflightClient> = {}): LinearPreflightClient {
  return {
    checkAuth: async () => ({ ok: true }),
    checkStatus: async () => ({ ok: true }),
    checkAssignee: async () => ({ ok: true }),
    ...overrides,
  };
}

function okCodex(overrides: Partial<CodexPreflightClient> = {}): CodexPreflightClient {
  return { checkAvailable: async () => ({ ok: true, version: '0.130.0' }), ...overrides };
}

describe('runPreflight', () => {
  it('passes when repo, git, auth, Linear, and Codex checks are green', async () => {
    const result = await runPreflight({ profile: profile(), targetBranch: 'symphony/ENG-1', git: okGit(), github: okGithub(), linear: okLinear(), codex: okCodex() });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((check) => check.name)).toContain('codex_available');
  });

  it('fails dirty checkout, wrong branch, in-progress merge, and existing target branches', async () => {
    const result = await runPreflight({
      profile: profile(),
      targetBranch: 'symphony/ENG-1',
      git: okGit({
        statusPorcelain: async () => ' M src/app.ts\n',
        currentBranch: async () => 'feature/manual',
        hasMergeOrRebaseInProgress: async () => true,
        branchExists: async () => true,
        remoteBranchExists: async () => true,
      }),
      github: okGithub(),
      linear: okLinear(),
      codex: okCodex(),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['dirty_main_checkout', 'main_checkout_not_on_base_branch', 'merge_or_rebase_in_progress', 'target_branch_exists_local', 'target_branch_exists_remote']));
  });

  it('fails non-worktree/bare repository and fetch/auth/tool readiness failures', async () => {
    const result = await runPreflight({
      profile: profile(),
      targetBranch: 'symphony/ENG-1',
      git: okGit({
        isWorktree: async () => false,
        isBareRepo: async () => true,
        fetchBase: async () => { throw new Error('fetch denied'); },
      }),
      github: okGithub({ checkAuth: async () => ({ ok: false, reason: 'gh missing' }) }),
      linear: okLinear({ checkAuth: async () => ({ ok: false, reason: 'linear missing' }), checkStatus: async () => ({ ok: false, reason: 'status missing' }), checkAssignee: async () => ({ ok: false, reason: 'assignee missing' }) }),
      codex: okCodex({ checkAvailable: async () => ({ ok: false, reason: 'codex missing' }) }),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['repo_not_worktree', 'repo_is_bare', 'base_fetch_failed', 'github_auth_unreadable', 'linear_auth_unreadable', 'linear_status_unreadable', 'linear_assignee_unreadable', 'codex_unavailable']));
  });

  it('respects disabled preflight flags', async () => {
    const result = await runPreflight({
      profile: profile({ require_main_checkout_clean: false, require_github_auth: false, require_linear_auth: false, require_codex_available: false }),
      targetBranch: 'symphony/ENG-1',
      git: okGit({ statusPorcelain: async () => ' M src/app.ts\n' }),
      github: okGithub({ checkAuth: async () => ({ ok: false, reason: 'gh missing' }) }),
      linear: okLinear({ checkAuth: async () => ({ ok: false, reason: 'linear missing' }) }),
      codex: okCodex({ checkAvailable: async () => ({ ok: false, reason: 'codex missing' }) }),
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.checks.find((check) => check.name === 'main_checkout_clean')).toBeUndefined();
  });

  it('fails closed when negative Git checks throw', async () => {
    const result = await runPreflight({
      profile: profile(),
      targetBranch: 'symphony/ENG-1',
      git: okGit({
        isBareRepo: async () => { throw new Error('git-dir unreadable'); },
        hasMergeOrRebaseInProgress: async () => { throw new Error('marker check failed'); },
        branchExists: async () => { throw new Error('local branch check failed'); },
        remoteBranchExists: async () => { throw new Error('remote branch check failed'); },
      }),
      github: okGithub(),
      linear: okLinear(),
      codex: okCodex(),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining(['repo_is_bare', 'merge_or_rebase_in_progress', 'target_branch_exists_local', 'target_branch_exists_remote']));
  });

  it('short-circuits repo-dependent checks for relative repo paths', async () => {
    let gitCalls = 0;
    const p = profile();
    p.repo.path = 'relative/repo';

    const result = await runPreflight({
      profile: p,
      targetBranch: 'symphony/ENG-1',
      git: okGit({ isWorktree: async () => { gitCalls += 1; return true; } }),
      github: okGithub(),
      linear: okLinear(),
      codex: okCodex(),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain('repo_path_not_absolute');
    expect(gitCalls).toBe(0);
  });

  it('separates Codex non-interactive and version failures', async () => {
    const result = await runPreflight({
      profile: profile(),
      targetBranch: 'symphony/ENG-1',
      git: okGit(),
      github: okGithub(),
      linear: okLinear(),
      codex: okCodex({ checkAvailable: async () => ({ ok: false, reason: 'too old', code: 'codex_version_too_old' }) }),
    });

    expect(result.failures).toContain('codex_version_too_old');
  });
});
