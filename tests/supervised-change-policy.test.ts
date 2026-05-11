import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../src/supervised/adapters/git.js';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';
import { createRunRecord, readRunById } from '../src/supervised/run-record/store.js';
import { transitionRun } from '../src/supervised/run-record/state-machine.js';
import { checkCodexChanges, type CommitChecksGitClient } from '../src/supervised/run/commit-checks.js';

function profile(overrides: Partial<SupervisedProfile> = {}): SupervisedProfile {
  return {
    schema_version: 1,
    name: 'p',
    repo: { path: '/repo', remote: 'origin', base_branch: 'main' },
    linear: {
      team: 'ENG', project: null, eligible_status: 'Todo', claim_status: 'In Progress', success_status: 'Ready for Review', failure_status: null,
      require_unassigned: true, required_labels: ['agent'], include_comments: true, max_comments: 2, comment_order: 'chronological',
      include_attachment_links: true, download_attachments: false, comment_max_chars: 100, output_tail_max_lines: 80, assignee: { mode: 'authenticated_user' },
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
    ...overrides,
  };
}

async function codexCompletedRun(homeDir: string) {
  const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-123', mutating: true, now: new Date('2026-01-01T00:00:00Z') });
  await transitionRun({ homeDir }, run.run_id, 'preflight_running');
  await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
  await transitionRun({ homeDir }, run.run_id, 'claimed');
  await transitionRun({ homeDir }, run.run_id, 'codex_running');
  await transitionRun({ homeDir }, run.run_id, 'codex_completed');
  return readRunById(homeDir, run.run_id);
}

function commit(overrides: Partial<Awaited<ReturnType<CommitChecksGitClient['newCommits']>>[number]> = {}) {
  return { sha: 'a'.repeat(40), subject: 'ENG-123 implement feature', body: '', authorName: 'Codex', authorEmail: 'codex@example.com', committerName: 'Codex Committer', committerEmail: 'committer@example.com', ...overrides };
}

function gitClient(overrides: Partial<CommitChecksGitClient> = {}): CommitChecksGitClient {
  return {
    newCommits: vi.fn(async () => [commit()]),
    changedFiles: vi.fn(async () => [{ status: 'A', path: 'src/feature.ts' }]),
    statusPorcelain: vi.fn(async () => ''),
    ...overrides,
  };
}

async function writeWorktreeFile(worktree: string, relativePath: string, content: string | Buffer): Promise<void> {
  const filePath = join(worktree, relativePath);
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content);
}

describe('checkCodexChanges', () => {
  it('writes diff summaries for clean Codex changes and keeps the run at codex_completed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'src/feature.ts', 'export const ok = true;\n');
    const run = await codexCompletedRun(homeDir);
    const git = gitClient();

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git });

    expect(result.ok).toBe(true);
    expect(git.newCommits).toHaveBeenCalledWith(worktreePath, 'b'.repeat(40), 'HEAD');
    expect(git.changedFiles).toHaveBeenCalledWith(worktreePath, 'b'.repeat(40), 'HEAD');
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('codex_completed');
    const summary = JSON.parse(await readFile(join(run.run_dir, 'diff-summary.json'), 'utf8'));
    expect(summary).toMatchObject({ run_id: run.run_id, issue_key: 'ENG-123', base_sha: 'b'.repeat(40) });
    expect(summary.commits).toHaveLength(1);
    expect(summary.commits[0]).toMatchObject({ committerName: 'Codex Committer', committerEmail: 'committer@example.com' });
    expect(summary.changed_files).toEqual([{ status: 'A', path: 'src/feature.ts' }]);
    const markdown = await readFile(join(run.run_dir, 'diff-summary.md'), 'utf8');
    expect(markdown).toContain('ENG-123 implement feature');
    expect(markdown).not.toContain('codex@example.com');
    expect(markdown).not.toContain('committer@example.com');
    const artifacts = JSON.parse(await readFile(join(run.run_dir, 'artifacts.json'), 'utf8'));
    expect(artifacts.artifacts).toEqual(expect.arrayContaining([
      { path: join(run.run_dir, 'diff-summary.json'), visibility: 'local_only', kind: 'diff_summary_json' },
      { path: join(run.run_dir, 'diff-summary.md'), visibility: 'redacted_shareable', kind: 'diff_summary_markdown' },
    ]));
  });

  it('fails with no_commit when Codex did not create a commit', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => []) }) });

    expect(result).toMatchObject({ ok: false, reason: 'no_commit' });
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('failed');
    expect(updated.reason).toBe('no_commit');
  });

  it('fails with dirty_worktree_after_codex when Codex leaves uncommitted changes', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ statusPorcelain: vi.fn(async () => ' M src/feature.ts\n') }) });

    expect(result).toMatchObject({ ok: false, reason: 'dirty_worktree_after_codex' });
    expect((await readRunById(homeDir, run.run_id)).reason).toBe('dirty_worktree_after_codex');
  });

  it('fails when commit messages do not reference the issue key', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => [commit({ subject: 'implement feature' })]) }) });

    expect(result).toMatchObject({ ok: false, reason: 'commit_message_policy_failed' });
  });

  it('accepts an issue key in the commit body/footer', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'src/feature.ts', 'ok\n');
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => [commit({ subject: 'implement feature', body: 'Refs: ENG-123\n' })]) }) });

    expect(result.ok).toBe(true);
  });

  it('fails change policy for forbidden paths, allowlist misses, oversized files, binary files, and secrets', async () => {
    const cases: Array<{ name: string; changed: ChangedFile[]; files?: Record<string, string | Buffer>; override?: Partial<SupervisedProfile>; expected?: string }> = [
      { name: 'forbidden path', changed: [{ status: 'M', path: '.env' }], files: { '.env': 'SAFE=value\n' }, override: { change_policy: { ...profile().change_policy, forbidden_paths: ['.env'] } }, expected: 'forbidden_path' },
      { name: 'forbidden env wildcard', changed: [{ status: 'M', path: '.env.local' }], files: { '.env.local': 'SAFE=value\n' }, override: { change_policy: { ...profile().change_policy, forbidden_paths: ['.env.*'] } }, expected: 'forbidden_path' },
      { name: 'forbidden nested pem', changed: [{ status: 'M', path: 'certs/private.pem' }], files: { 'certs/private.pem': 'not a cert\n' }, override: { change_policy: { ...profile().change_policy, forbidden_paths: ['**/*.pem'] } }, expected: 'forbidden_path' },
      { name: 'not in allowed paths', changed: [{ status: 'M', path: 'docs/readme.md' }], files: { 'docs/readme.md': 'docs\n' }, override: { change_policy: { ...profile().change_policy, allowed_paths: ['src/**'] } }, expected: 'path_not_allowed' },
      { name: 'oversized file', changed: [{ status: 'A', path: 'src/big.txt' }], files: { 'src/big.txt': 'abcdef' }, override: { change_policy: { ...profile().change_policy, max_file_bytes: 4 } }, expected: 'file_too_large' },
      { name: 'binary file', changed: [{ status: 'A', path: 'src/blob.bin' }], files: { 'src/blob.bin': Buffer.from([0x61, 0x00, 0x62]) }, expected: 'binary_file' },
      { name: 'secret content', changed: [{ status: 'A', path: 'src/secret.txt' }], files: { 'src/secret.txt': '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\n' }, expected: 'private_key_block' },
    ];

    for (const item of cases) {
      const homeDir = await mkdtemp(join(tmpdir(), `symphony-change-policy-${item.name.replaceAll(' ', '-')}-`));
      const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
      const run = await codexCompletedRun(homeDir);
      for (const [relative, content] of Object.entries(item.files ?? {})) await writeWorktreeFile(worktreePath, relative, content);

      const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(item.override), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ changedFiles: vi.fn(async () => item.changed) }) });

      expect(result).toMatchObject({ ok: false, reason: 'change_policy_failed' });
      const summary = JSON.parse(await readFile(join(run.run_dir, 'diff-summary.json'), 'utf8'));
      expect(summary.policy_findings.map((finding: { code: string }) => finding.code)).toContain(item.expected);
    }
  });

  it('does not fail a changed documentation file for standalone secret-related words without credential values', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-docs-secret-keyword-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'docs/API.md', 'The API authentication flow does not expose secrets to clients.\n');
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ changedFiles: vi.fn(async () => [{ status: 'M', path: 'docs/API.md' }]) }) });

    expect(result.ok).toBe(true);
    const summary = JSON.parse(await readFile(join(run.run_dir, 'diff-summary.json'), 'utf8'));
    expect(summary.policy_findings).toEqual([]);
  });

  it('fails when commit authors violate configured email policy', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'src/feature.ts', 'ok\n');
    const run = await codexCompletedRun(homeDir);
    const prof = profile({ git: { require_author_email_domains: ['example.com'], forbid_author_emails: ['bad@example.com'], author: null } });

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: prof, worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => [commit({ subject: 'ENG-123 bad author', authorName: 'Bad', authorEmail: 'bad@example.com', committerName: 'Bad', committerEmail: 'bad@example.com' })]) }) });

    expect(result).toMatchObject({ ok: false, reason: 'commit_message_policy_failed' });
    const summary = JSON.parse(await readFile(join(run.run_dir, 'diff-summary.json'), 'utf8'));
    expect(summary.commit_findings.map((finding: { code: string }) => finding.code)).toContain('forbidden_author_email');
    expect(await readFile(join(run.run_dir, 'diff-summary.md'), 'utf8')).not.toContain('bad@example.com');
  });

  it('does not expose email-like author or committer names in shareable markdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'src/feature.ts', 'ok\n');
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => [commit({ authorName: 'author@example.com', committerName: 'committer@example.com' })]) }) });

    expect(result.ok).toBe(true);
    const markdown = await readFile(join(run.run_dir, 'diff-summary.md'), 'utf8');
    expect(markdown).not.toContain('author@example.com');
    expect(markdown).not.toContain('committer@example.com');
  });

  it('redacts email-like strings from commit subjects and changed paths in shareable markdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    await writeWorktreeFile(worktreePath, 'docs/alice@example.com.md', 'ok\n');
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ newCommits: vi.fn(async () => [commit({ subject: 'ENG-123 notify alice@example.com' })]), changedFiles: vi.fn(async () => [{ status: 'A', path: 'docs/alice@example.com.md' }]) }) });

    expect(result.ok).toBe(true);
    const markdown = await readFile(join(run.run_dir, 'diff-summary.md'), 'utf8');
    expect(markdown).not.toContain('alice@example.com');
    expect(markdown).toContain('[REDACTED_EMAIL]');
  });

  it('fails change policy when a changed path is a symlink escaping the worktree', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-change-policy-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'symphony-worktree-'));
    const outside = await mkdtemp(join(tmpdir(), 'symphony-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'safe\n');
    await symlink(join(outside, 'secret.txt'), join(worktreePath, 'linked.txt'));
    const run = await codexCompletedRun(homeDir);

    const result = await checkCodexChanges({ homeDir, runId: run.run_id, profile: profile(), worktreePath, baseSha: 'b'.repeat(40), git: gitClient({ changedFiles: vi.fn(async () => [{ status: 'A', path: 'linked.txt' }]) }) });

    expect(result).toMatchObject({ ok: false, reason: 'change_policy_failed' });
    const summary = JSON.parse(await readFile(join(run.run_dir, 'diff-summary.json'), 'utf8'));
    expect(summary.policy_findings.map((finding: { code: string }) => finding.code)).toContain('symlink_path');
  });
});
