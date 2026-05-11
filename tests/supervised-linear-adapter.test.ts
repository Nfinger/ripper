import { describe, expect, it, vi } from 'vitest';
import { LinearReadAdapter } from '../src/supervised/adapters/linear.js';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';

function profile(overrides: Partial<SupervisedProfile['linear']> = {}): SupervisedProfile {
  return {
    schema_version: 1,
    name: 'p',
    repo: { path: '/tmp/repo', remote: 'origin', base_branch: 'main' },
    linear: {
      team: 'ENG', project: null, eligible_status: 'Todo', claim_status: 'In Progress', success_status: 'Ready for Review', failure_status: null,
      require_unassigned: true, required_labels: ['agent'], include_comments: true, max_comments: 2, comment_order: 'chronological',
      include_attachment_links: true, download_attachments: false, comment_max_chars: 100, output_tail_max_lines: 80, assignee: { mode: 'authenticated_user' }, ...overrides,
    },
    agent: { kind: 'codex', command: 'codex', model: 'gpt-5.5', timeout_minutes: 60, allow_network: true, allow_web_lookup: true, allow_browser_automation: false },
    prompt: { include_repo_instruction_files: [], repo_instruction_max_chars: 20000, extra_instructions: null },
    preflight: { require_main_checkout_clean: true, require_main_checkout_on_base_branch: true, require_no_merge_or_rebase_in_progress: true, require_base_fetchable: true, require_target_branch_absent: true, require_github_auth: true, require_linear_auth: true, require_codex_available: true },
    validation: { network: 'allowed', commands: [] },
    change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false },
    git: { require_author_email_domains: [], forbid_author_emails: [], author: null },
    github: { create_pr: true, draft: false, require_ci_green_before_success: true, ci_timeout_minutes: 30, ci_poll_interval_seconds: 30, required_checks: { mode: 'github_required_checks', fallback: [] }, labels: { best_effort: true, create_missing: false, names: [] }, reviewers: { users: [], teams: [], best_effort: true }, assignees: { users: [], best_effort: true }, pr_body_max_chars: 12000 },
    run: { max_total_minutes: 100 },
    cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true },
  };
}

function mockFetch(data: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('LinearReadAdapter', () => {
  it('finds eligible issues using profile filters and normalizes comments/labels', async () => {
    const fetchImpl = mockFetch({ issues: { nodes: [{ id: 'i1', identifier: 'ENG-1', title: 'Fix thing', description: 'body', url: 'https://linear/ENG-1', assignee: null, state: { name: 'Todo' }, labels: { nodes: [{ name: 'agent' }] }, comments: { nodes: [{ body: 'first' }, { body: 'second' }, { body: 'third' }] } }] } });
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    const issues = await adapter.findEligibleIssues(profile());

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'ENG-1', title: 'Fix thing', labels: ['agent'], comments: ['first', 'second'] });
    const request = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(request.variables.filter).toMatchObject({ team: { key: { eq: 'ENG' } }, state: { name: { eq: 'Todo' } }, assignee: { null: true } });
  });

  it('builds required-label eligibility as all-label gates and honors include_comments=false', async () => {
    const fetchImpl = mockFetch({ issues: { nodes: [{ id: 'i1', identifier: 'ENG-1', title: 'Fix thing', description: 'body', url: 'https://linear/ENG-1', assignee: null, state: { name: 'Todo' }, labels: { nodes: [{ name: 'agent' }, { name: 'codex' }] }, comments: { nodes: [{ body: 'hidden' }] } }] } });
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    const issues = await adapter.findEligibleIssues(profile({ required_labels: ['agent', 'codex'], include_comments: false }));

    expect(issues[0]?.comments).toEqual([]);
    const request = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(request.variables.filter.and).toEqual([
      { labels: { some: { name: { eq: 'agent' } } } },
      { labels: { some: { name: { eq: 'codex' } } } },
    ]);
    expect(request.variables.filter.labels).toBeUndefined();
  });

  it('getIssueByKey applies the full profile eligibility filter plus identifier', async () => {
    const fetchImpl = mockFetch({ issues: { nodes: [] } });
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    await expect(adapter.getIssueByKey('ENG-404', profile({ project: 'Backend', required_labels: ['agent'] }))).resolves.toBeNull();
    const request = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(request.variables.filter).toMatchObject({
      identifier: { eq: 'ENG-404' },
      team: { key: { eq: 'ENG' } },
      state: { name: { eq: 'Todo' } },
      project: { name: { eq: 'Backend' } },
      assignee: { null: true },
    });
    expect(request.variables.filter.and).toEqual([{ labels: { some: { name: { eq: 'agent' } } } }]);
  });

  it('verifies statuses and assignee', async () => {
    const fetchImpl = mockFetch({ workflowStates: { nodes: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready for Review' }] }, viewer: { id: 'me', name: 'Me' } });
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    await expect(adapter.verifyStatuses(profile())).resolves.toEqual({ ok: true, missing: [] });
    await expect(adapter.verifyAssignee(profile())).resolves.toEqual({ ok: true, assigneeId: 'me' });
  });

  it('reports missing statuses and configured user assignees without mutation', async () => {
    const fetchImpl = mockFetch({ workflowStates: { nodes: [{ name: 'Todo' }] }, user: { id: 'u1', name: 'User' } });
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    await expect(adapter.verifyStatuses(profile())).resolves.toEqual({ ok: false, missing: ['In Progress', 'Ready for Review'] });
    await expect(adapter.verifyAssignee(profile({ assignee: { mode: 'user_id', user_id: 'u1' } }))).resolves.toEqual({ ok: true, assigneeId: 'u1' });
  });
});
