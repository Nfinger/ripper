import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDryRun } from '../src/supervised/run/dry-run.js';
import { handleRunCommand } from '../src/supervised/commands/run.js';
import type { LinearIssue } from '../src/supervised/adapters/linear.js';

const ISSUE: LinearIssue = { id: 'i1', key: 'ENG-1', title: 'Fix bug', description: 'body', url: 'https://linear/ENG-1', status: 'Todo', labels: ['agent'], assigneeId: null, teamKey: 'ENG', projectName: null, comments: ['comment'] };

async function setupHome(): Promise<{ homeDir: string; repo: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'symphony-dry-run-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'symphony-dry-run-repo-'));
  await writeFile(join(repo, 'AGENTS.md'), 'repo guidance');
  await mkdir(join(homeDir, '.symphony', 'profiles'), { recursive: true });
  await writeFile(join(homeDir, '.symphony', 'profiles', 'p.yaml'), profileYaml(repo));
  return { homeDir, repo };
}

describe('runDryRun', () => {
  it('creates a non-mutating run record and preview artifacts for exactly one issue', async () => {
    const { homeDir } = await setupHome();
    const result = await runDryRun({ profileName: 'p', homeDir, linear: { findEligibleIssues: async () => [ISSUE] } });

    expect(result.exitCode).toBe(0);
    expect(result.run.status).toBe('dry_run');
    expect(result.run.mutating).toBe(false);
    expect(await readFile(join(result.run.run_dir, 'linear-issue.json'), 'utf8')).toContain('ENG-1');
    expect(await readFile(join(result.run.run_dir, 'linear-issue.md'), 'utf8')).toContain('# ENG-1: Fix bug');
    expect(await readFile(join(result.run.run_dir, 'prompt.md'), 'utf8')).toContain('DRY RUN — NOT EXECUTED');
    expect(await readFile(join(result.run.run_dir, 'pr-body.preview.md'), 'utf8')).toContain('ENG-1');
    expect(await readFile(join(result.run.run_dir, 'linear-claim.preview.md'), 'utf8')).toContain('would claim');
    expect(await readFile(join(result.run.run_dir, 'result.md'), 'utf8')).toContain('Dry run complete');
    const artifacts = JSON.parse(await readFile(join(result.run.run_dir, 'artifacts.json'), 'utf8'));
    expect(artifacts.artifacts.map((artifact: { kind: string }) => artifact.kind)).toContain('prompt');
  });

  it('refuses when there are no candidates or multiple candidates', async () => {
    const { homeDir } = await setupHome();

    const none = await runDryRun({ profileName: 'p', homeDir, now: new Date('2026-01-01T00:00:00Z'), linear: { findEligibleIssues: async () => [] } });
    const many = await runDryRun({ profileName: 'p', homeDir, now: new Date('2026-01-01T00:00:01Z'), linear: { findEligibleIssues: async () => [ISSUE, { ...ISSUE, key: 'ENG-2' }] } });

    expect(none.exitCode).not.toBe(0);
    expect(none.run.status).toBe('refused');
    expect(none.run.reason).toBe('no_candidates');
    expect(many.run.status).toBe('refused');
    expect(many.run.reason).toBe('multiple_candidates');
  });
  it('uses --issue only as an eligibility narrowing filter', async () => {
    const { homeDir } = await setupHome();
    const linear = {
      getIssueByKey: async () => null,
      findEligibleIssues: async () => { throw new Error('should use keyed lookup'); },
    };

    const result = await runDryRun({ profileName: 'p', homeDir, issueKey: 'ENG-999', linear });

    expect(result.exitCode).not.toBe(0);
    expect(result.run.status).toBe('refused');
    expect(result.run.reason).toBe('issue_not_eligible');
  });

  it('writes redacted dry-run preview artifacts with explicit not-posted stamps', async () => {
    const { homeDir } = await setupHome();
    const sensitiveIssue = {
      ...ISSUE,
      title: 'Fix leaked api_key: sk-live-1234567890',
      description: 'path /Users/homebase/secret and Authorization: Bearer abc.def.ghi',
      comments: ['password=hunter2 in /tmp/token.txt'],
    };

    const result = await runDryRun({ profileName: 'p', homeDir, linear: { findEligibleIssues: async () => [sensitiveIssue] } });

    const prPreview = await readFile(join(result.run.run_dir, 'pr-body.preview.md'), 'utf8');
    const issueMarkdown = await readFile(join(result.run.run_dir, 'linear-issue.md'), 'utf8');
    const claimPreview = await readFile(join(result.run.run_dir, 'linear-claim.preview.md'), 'utf8');
    expect(prPreview).toContain('DRY RUN — NOT POSTED');
    expect(claimPreview).toContain('DRY RUN — NOT POSTED');
    expect(`${prPreview}\n${issueMarkdown}`).not.toContain('sk-live-1234567890');
    expect(`${prPreview}\n${issueMarkdown}`).not.toContain('Bearer abc.def.ghi');
    expect(`${prPreview}\n${issueMarkdown}`).not.toContain('/Users/homebase/secret');
    expect(`${prPreview}\n${issueMarkdown}`).not.toContain('/tmp/token.txt');
  });
});

describe('handleRunCommand dry-run', () => {
  it('rejects missing --issue values and unknown flags', async () => {
    const { homeDir } = await setupHome();
    let stderr = '';
    const missingIssue = await handleRunCommand({ argv: ['p', '--dry-run', '--issue'], homeDir, stdout: () => {}, stderr: (text) => { stderr += text; }, linear: { findEligibleIssues: async () => [ISSUE] } });
    expect(missingIssue.exitCode).not.toBe(0);
    expect(stderr).toContain('requires a value');

    stderr = '';
    const unknown = await handleRunCommand({ argv: ['p', '--dry-run', '--wat'], homeDir, stdout: () => {}, stderr: (text) => { stderr += text; }, linear: { findEligibleIssues: async () => [ISSUE] } });
    expect(unknown.exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown option');
  });
});

function profileYaml(repo: string): string {
  return `schema_version: 1
name: p
repo: { path: ${JSON.stringify(repo)}, remote: origin, base_branch: main }
linear:
  team: ENG
  project: null
  eligible_status: Todo
  claim_status: In Progress
  success_status: Ready for Review
  failure_status: null
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
prompt: { include_repo_instruction_files: [AGENTS.md], repo_instruction_max_chars: 20000, extra_instructions: null }
preflight: { require_main_checkout_clean: true, require_main_checkout_on_base_branch: true, require_no_merge_or_rebase_in_progress: true, require_base_fetchable: true, require_target_branch_absent: true, require_github_auth: true, require_linear_auth: true, require_codex_available: true }
validation: { network: allowed, commands: [] }
change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false }
git: { require_author_email_domains: [], forbid_author_emails: [], author: null }
github:
  create_pr: true
  draft: false
  require_ci_green_before_success: true
  ci_timeout_minutes: 30
  ci_poll_interval_seconds: 30
  required_checks: { mode: github_required_checks, fallback: [] }
  labels: { best_effort: true, create_missing: false, names: [] }
  reviewers: { users: [], teams: [], best_effort: true }
  assignees: { users: [], best_effort: true }
  pr_body_max_chars: 12000
run: { max_total_minutes: 100 }
cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true }
`;
}
