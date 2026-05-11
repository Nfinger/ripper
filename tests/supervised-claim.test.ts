import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LinearReadAdapter, type LinearIssue } from '../src/supervised/adapters/linear.js';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';
import { createRunRecord, readRunById } from '../src/supervised/run-record/store.js';
import { transitionRun } from '../src/supervised/run-record/state-machine.js';
import { claimSelectedIssue, type ClaimLinearClient } from '../src/supervised/run/claim.js';

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

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return { id: 'issue-id', key: 'ENG-1', title: 'Fix thing', description: 'body', url: 'https://linear/ENG-1', status: 'Todo', labels: ['agent'], assigneeId: null, teamKey: 'ENG', projectName: null, comments: [], ...overrides };
}

function mockFetchSequence(payloads: unknown[]) {
  let idx = 0;
  return vi.fn(async () => {
    const data = payloads[idx++] ?? payloads[payloads.length - 1];
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('LinearReadAdapter claim mutations', () => {
  it('sets claim status and assignee, posts a claim comment, then refetches issue', async () => {
    const fetchImpl = mockFetchSequence([
      { viewer: { id: 'me', name: 'Me' } },
      { workflowStates: { nodes: [{ id: 'state-claim', name: 'In Progress' }] } },
      { issueUpdate: { success: true, issue: { id: 'issue-id' } } },
      { commentCreate: { success: true, comment: { id: 'comment-id' } } },
      { issue: { id: 'issue-id', identifier: 'ENG-1', title: 'Fix thing', description: 'body', url: 'https://linear/ENG-1', state: { name: 'In Progress' }, assignee: { id: 'me' }, labels: { nodes: [{ name: 'agent' }] }, comments: { nodes: [] } } },
    ]);
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    const assigneeId = await adapter.resolveAssigneeId(profile());
    await adapter.claimIssue({ issueId: 'issue-id', profile: profile(), assigneeId });
    await adapter.postComment('issue-id', 'Claimed by Symphony');
    const refetched = await adapter.getIssueById('issue-id', profile());

    expect(refetched).toMatchObject({ key: 'ENG-1', status: 'In Progress', assigneeId: 'me' });
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[2].variables.input).toEqual({ stateId: 'state-claim', assigneeId: 'me' });
    expect(bodies[3].variables).toEqual({ issueId: 'issue-id', body: 'Claimed by Symphony' });
  });

  it('updates issue status without changing assignee', async () => {
    const fetchImpl = mockFetchSequence([
      { workflowStates: { nodes: [{ id: 'state-success', name: 'Ready for Review' }] } },
      { issueUpdate: { success: true, issue: { id: 'issue-id' } } },
    ]);
    const adapter = new LinearReadAdapter({ apiKey: 'test-token', fetchImpl });

    await adapter.updateIssueStatus({ issueId: 'issue-id', profile: profile(), statusName: 'Ready for Review' });

    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[1].variables).toEqual({ id: 'issue-id', input: { stateId: 'state-success' } });
  });
});

describe('claimSelectedIssue', () => {
  it('claims exactly one selected issue, posts a Linear comment, verifies status and assignee, and transitions run to claimed', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-claim-'));
    const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true, now: new Date('2026-01-01T00:00:00Z') });
    await transitionRun({ homeDir }, run.run_id, 'preflight_running', null, new Date('2026-01-01T00:00:01Z'));
    await transitionRun({ homeDir }, run.run_id, 'candidate_selected', null, new Date('2026-01-01T00:00:02Z'));
    const linear: ClaimLinearClient = {
      resolveAssigneeId: vi.fn(async () => 'me'),
      claimIssue: vi.fn(async () => undefined),
      postComment: vi.fn(async () => undefined),
      getIssueById: vi.fn()
        .mockResolvedValueOnce(issue({ status: 'Todo', assigneeId: null }))
        .mockResolvedValueOnce(issue({ status: 'In Progress', assigneeId: 'me' })),
    };

    const result = await claimSelectedIssue({ homeDir, runId: run.run_id, profile: profile(), issue: issue(), linear, now: new Date('2026-01-01T00:00:03Z') });

    expect(result.ok).toBe(true);
    expect(linear.claimIssue).toHaveBeenCalledWith({ issueId: 'issue-id', profile: expect.any(Object), assigneeId: 'me' });
    expect(linear.postComment).toHaveBeenCalledWith('issue-id', expect.stringContaining('Run record:'));
    const claimArtifact = await readFile(path.join(run.run_dir, 'linear-claim.md'), 'utf8');
    expect(claimArtifact).toContain('Symphony claimed ENG-1');
    const artifacts = JSON.parse(await readFile(path.join(run.run_dir, 'artifacts.json'), 'utf8'));
    expect(artifacts.artifacts).toContainEqual({ path: path.join(run.run_dir, 'linear-claim.md'), visibility: 'linear_visible', kind: 'linear_claim' });
    expect((await readRunById(homeDir, run.run_id)).status).toBe('claimed');
  });

  it('fails post-claim with claim_verification_failed when refetch does not show the claimed status and assignee', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-claim-'));
    const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true, now: new Date('2026-01-01T00:00:00Z') });
    await transitionRun({ homeDir }, run.run_id, 'preflight_running');
    await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
    const linear: ClaimLinearClient = {
      resolveAssigneeId: vi.fn(async () => 'me'),
      claimIssue: vi.fn(async () => undefined),
      postComment: vi.fn(async () => undefined),
      getIssueById: vi.fn()
        .mockResolvedValueOnce(issue({ status: 'Todo', assigneeId: null }))
        .mockResolvedValueOnce(issue({ status: 'Todo', assigneeId: null })),
    };

    const result = await claimSelectedIssue({ homeDir, runId: run.run_id, profile: profile(), issue: issue(), linear });

    expect(result).toEqual({ ok: false, reason: 'claim_verification_failed' });
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('failed');
    expect(updated.reason).toBe('claim_verification_failed');
  });

  it('refuses before mutation when the selected issue changed before claim', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-claim-'));
    const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true });
    await transitionRun({ homeDir }, run.run_id, 'preflight_running');
    await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
    const linear: ClaimLinearClient = {
      resolveAssigneeId: vi.fn(async () => 'me'),
      claimIssue: vi.fn(async () => undefined),
      postComment: vi.fn(async () => undefined),
      getIssueById: vi.fn(async () => issue({ status: 'Todo', assigneeId: 'someone-else' })),
    };

    const result = await claimSelectedIssue({ homeDir, runId: run.run_id, profile: profile(), issue: issue(), linear });

    expect(result).toEqual({ ok: false, reason: 'issue_changed_before_claim' });
    expect(linear.claimIssue).not.toHaveBeenCalled();
    expect(linear.postComment).not.toHaveBeenCalled();
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('refused');
    expect(updated.reason).toBe('issue_changed_before_claim');
  });

  it('refuses before mutation when the selected issue moved out of the configured project', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-claim-'));
    const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true });
    await transitionRun({ homeDir }, run.run_id, 'preflight_running');
    await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
    const linear: ClaimLinearClient = {
      resolveAssigneeId: vi.fn(async () => 'me'),
      claimIssue: vi.fn(async () => undefined),
      postComment: vi.fn(async () => undefined),
      getIssueById: vi.fn(async () => issue({ projectName: 'Wrong Project' })),
    };

    const result = await claimSelectedIssue({ homeDir, runId: run.run_id, profile: profile({ project: 'Backend' }), issue: issue({ projectName: 'Backend' }), linear });

    expect(result).toEqual({ ok: false, reason: 'issue_changed_before_claim' });
    expect(linear.claimIssue).not.toHaveBeenCalled();
    expect((await readRunById(homeDir, run.run_id)).status).toBe('refused');
  });

  it('marks the run claimed if the issue update succeeded but claim comment posting fails', async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), 'symphony-claim-'));
    const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true });
    await transitionRun({ homeDir }, run.run_id, 'preflight_running');
    await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
    const linear: ClaimLinearClient = {
      resolveAssigneeId: vi.fn(async () => 'me'),
      claimIssue: vi.fn(async () => undefined),
      postComment: vi.fn(async () => { throw new Error('comment failed'); }),
      getIssueById: vi.fn(async () => issue({ status: 'Todo', assigneeId: null })),
    };

    await expect(claimSelectedIssue({ homeDir, runId: run.run_id, profile: profile(), issue: issue(), linear })).rejects.toThrow('comment failed');

    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('claimed');
    expect(updated.reason).toBeNull();
  });
});
