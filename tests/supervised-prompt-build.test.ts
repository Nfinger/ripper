import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/supervised/prompt/build.js';
import type { LinearIssue } from '../src/supervised/adapters/linear.js';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';

function profile(repoPath: string): SupervisedProfile {
  return {
    schema_version: 1, name: 'p', repo: { path: repoPath, remote: 'origin', base_branch: 'main' },
    linear: { team: 'ENG', project: null, eligible_status: 'Todo', claim_status: 'In Progress', success_status: 'Ready for Review', failure_status: null, require_unassigned: true, required_labels: [], include_comments: true, max_comments: 20, comment_order: 'chronological', include_attachment_links: true, download_attachments: false, comment_max_chars: 8000, output_tail_max_lines: 80, assignee: { mode: 'authenticated_user' } },
    agent: { kind: 'codex', command: 'codex', model: 'gpt-5.5', timeout_minutes: 60, allow_network: true, allow_web_lookup: true, allow_browser_automation: false },
    prompt: { include_repo_instruction_files: ['AGENTS.md', 'README.md'], repo_instruction_max_chars: 20, extra_instructions: 'Prefer small changes.' },
    preflight: { require_main_checkout_clean: true, require_main_checkout_on_base_branch: true, require_no_merge_or_rebase_in_progress: true, require_base_fetchable: true, require_target_branch_absent: true, require_github_auth: true, require_linear_auth: true, require_codex_available: true },
    validation: { network: 'allowed', commands: [] }, change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false }, git: { require_author_email_domains: [], forbid_author_emails: [], author: null }, github: { create_pr: true, draft: false, require_ci_green_before_success: true, ci_timeout_minutes: 30, ci_poll_interval_seconds: 30, required_checks: { mode: 'github_required_checks', fallback: [] }, labels: { best_effort: true, create_missing: false, names: [] }, reviewers: { users: [], teams: [], best_effort: true }, assignees: { users: [], best_effort: true }, pr_body_max_chars: 12000 }, run: { max_total_minutes: 100 }, cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true },
  };
}

const issue: LinearIssue = { id: 'i1', key: 'ENG-1', title: 'Fix bug', description: 'Detailed issue body', url: 'https://linear/ENG-1', status: 'Todo', labels: ['agent'], assigneeId: null, teamKey: 'ENG', projectName: null, comments: ['comment one', 'comment two'] };

describe('buildPrompt', () => {
  it('includes issue title/body/comments, do-not-do section, repo instructions, and extra instructions', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'symphony-prompt-'));
    await writeFile(join(repo, 'AGENTS.md'), 'agent instructions that are long enough to truncate');
    await writeFile(join(repo, 'README.md'), 'readme should be excluded');

    const result = await buildPrompt({ profile: profile(repo), issue, runId: 'run-1', dryRun: false, runDir: '/Users/homebase/.symphony/runs/run-1' });

    expect(result.prompt).toContain('ENG-1: Fix bug');
    expect(result.prompt).toContain('Detailed issue body');
    expect(result.prompt).toContain('comment one');
    expect(result.prompt).toContain('DO NOT');
    expect(result.prompt).toContain('do not create or push branches');
    expect(result.prompt).toContain('Prefer small changes.');
    expect(result.prompt).toContain('AGENTS.md');
    expect(result.prompt).toContain('[TRUNCATED]');
    expect(result.prompt).not.toContain('readme should be excluded');
    expect(result.prompt).not.toContain('/Users/homebase/.symphony/runs/run-1');
    expect(result.includedInstructionFiles).toEqual(['AGENTS.md']);
  });

  it('stamps dry-run prompts as not executed', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'symphony-prompt-'));
    const result = await buildPrompt({ profile: profile(repo), issue, runId: 'run-1', dryRun: true });

    expect(result.prompt).toContain('DRY RUN — NOT EXECUTED');
  });
});
