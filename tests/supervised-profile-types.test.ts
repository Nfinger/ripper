import { describe, expect, it } from 'vitest';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';

describe('SupervisedProfile type', () => {
  it('accepts a minimal v1 profile shape', () => {
    const profile: SupervisedProfile = {
      schema_version: 1,
      name: 'p',
      repo: { path: '/tmp/repo', remote: 'origin', base_branch: 'main' },
      linear: {
        team: 'ENG',
        project: null,
        eligible_status: 'Todo',
        claim_status: 'In Progress',
        success_status: 'Ready for Review',
        failure_status: null,
        require_unassigned: true,
        required_labels: [],
        include_comments: true,
        max_comments: 20,
        comment_order: 'chronological',
        include_attachment_links: true,
        download_attachments: false,
        comment_max_chars: 8000,
        output_tail_max_lines: 80,
        assignee: { mode: 'authenticated_user' },
      },
      agent: { kind: 'codex', command: 'codex', model: 'gpt-5.5', timeout_minutes: 60, allow_network: true, allow_web_lookup: true, allow_browser_automation: false },
      agent_review: { enabled: true, command: 'codex', model: 'gpt-5.5', timeout_seconds: 300, max_fix_attempts: 2 },
      prompt: { include_repo_instruction_files: [], repo_instruction_max_chars: 20000, extra_instructions: null },
      knowledge: { enabled: true, include: ['docs/specs/*.md', 'docs/adr/*.md'], max_bytes: 80000 },
      preflight: { require_main_checkout_clean: true, require_main_checkout_on_base_branch: true, require_no_merge_or_rebase_in_progress: true, require_base_fetchable: true, require_target_branch_absent: true, require_github_auth: true, require_linear_auth: true, require_codex_available: true },
      verification: { enabled: false, mode: 'generic_smoke', commands: [] },
      validation: { network: 'allowed', commands: [] },
      change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false },
      git: { require_author_email_domains: [], forbid_author_emails: [], author: null },
      github: {
        create_pr: true,
        draft: false,
        require_ci_green_before_success: true,
        ci_timeout_minutes: 30,
        ci_poll_interval_seconds: 30,
        required_checks: { mode: 'github_required_checks', fallback: [] },
        labels: { best_effort: true, create_missing: false, names: [] },
        reviewers: { users: [], teams: [], best_effort: true },
        assignees: { users: [], best_effort: true },
        pr_body_max_chars: 12000,
      },
      run: { max_total_minutes: 100 },
      cleanup: {
        delete_local_branch_on_success: true,
        delete_local_worktree_on_success: true,
        delete_remote_branch_on_success: false,
        delete_run_record_on_success: false,
        keep_local_branch_on_failure: true,
        keep_local_branch_on_warning: true,
      },
    };

    expect(profile.agent.kind).toBe('codex');
  });
});
