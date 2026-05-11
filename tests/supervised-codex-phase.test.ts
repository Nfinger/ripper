import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';
import { createRunRecord, readRunById } from '../src/supervised/run-record/store.js';
import { transitionRun } from '../src/supervised/run-record/state-machine.js';
import { runCodexPhase, type CodexPhaseCodexClient, type CodexPhaseGitClient } from '../src/supervised/run/codex-phase.js';

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

async function claimedRun(homeDir: string) {
  const run = await createRunRecord({ homeDir, profileName: 'p', profileHash: 'hash', issueKey: 'ENG-1', mutating: true, now: new Date('2026-01-01T00:00:00Z') });
  await transitionRun({ homeDir }, run.run_id, 'preflight_running');
  await transitionRun({ homeDir }, run.run_id, 'candidate_selected');
  await transitionRun({ homeDir }, run.run_id, 'claimed');
  return readRunById(homeDir, run.run_id);
}

describe('runCodexPhase', () => {
  it('creates a per-run worktree, stores prompt/log/final artifacts, and transitions to codex_completed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-codex-phase-'));
    const run = await claimedRun(homeDir);
    const git: CodexPhaseGitClient = { createWorktree: vi.fn(async () => undefined) };
    const codex: CodexPhaseCodexClient = { run: vi.fn(async () => ({ ok: true, finalText: 'done', exitCode: 0, timedOut: false })) };

    const result = await runCodexPhase({ homeDir, runId: run.run_id, profile: profile(), prompt: 'Do work', branch: 'symphony/ENG-1', baseRef: 'origin/main', git, codex });

    const worktreePath = join(homeDir, '.symphony', 'worktrees', run.run_id);
    expect(result).toEqual({ ok: true, worktreePath });
    expect(git.createWorktree).toHaveBeenCalledWith('/repo', worktreePath, 'symphony/ENG-1', 'origin/main');
    expect(codex.run).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktreePath, promptPath: join(run.run_dir, 'prompt.md'), rawLogPath: join(run.run_dir, 'codex.log'), redactedLogPath: join(run.run_dir, 'codex.redacted.log') }));
    expect(await readFile(join(run.run_dir, 'prompt.md'), 'utf8')).toBe('Do work');
    expect(await readFile(join(run.run_dir, 'codex-final.md'), 'utf8')).toBe('done');
    const artifacts = JSON.parse(await readFile(join(run.run_dir, 'artifacts.json'), 'utf8'));
    expect(artifacts.artifacts).toEqual(expect.arrayContaining([
      { path: join(run.run_dir, 'prompt.md'), visibility: 'local_only', kind: 'prompt' },
      { path: join(run.run_dir, 'codex.log'), visibility: 'local_only', kind: 'codex_log' },
      { path: join(run.run_dir, 'codex.redacted.log'), visibility: 'redacted_shareable', kind: 'codex_redacted_log' },
      { path: join(run.run_dir, 'codex-final.md'), visibility: 'redacted_shareable', kind: 'codex_final' },
    ]));
    expect((await readRunById(homeDir, run.run_id)).status).toBe('codex_completed');
  });

  it('maps Codex timeout to timed_out/codex_timeout', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-codex-phase-'));
    const run = await claimedRun(homeDir);
    const git: CodexPhaseGitClient = { createWorktree: vi.fn(async () => undefined) };
    const codex: CodexPhaseCodexClient = { run: vi.fn(async () => ({ ok: false, reason: 'codex_timeout', exitCode: 124, timedOut: true })) };

    const result = await runCodexPhase({ homeDir, runId: run.run_id, profile: profile(), prompt: 'Do work', branch: 'symphony/ENG-1', baseRef: 'origin/main', git, codex });

    expect(result).toEqual({ ok: false, reason: 'codex_timeout' });
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('timed_out');
    expect(updated.reason).toBe('codex_timeout');
  });

  it('fails the run record when Codex execution throws after entering codex_running', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-codex-phase-'));
    const run = await claimedRun(homeDir);
    const git: CodexPhaseGitClient = { createWorktree: vi.fn(async () => undefined) };
    const codex: CodexPhaseCodexClient = { run: vi.fn(async () => { throw new Error('spawn exploded'); }) };

    const result = await runCodexPhase({ homeDir, runId: run.run_id, profile: profile(), prompt: 'Do work', branch: 'symphony/ENG-1', baseRef: 'origin/main', git, codex });

    expect(result).toEqual({ ok: false, reason: 'codex_unavailable' });
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('failed');
    expect(updated.reason).toBe('codex_unavailable');
  });

  it('fails the run record when worktree creation fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'symphony-codex-phase-'));
    const run = await claimedRun(homeDir);
    const git: CodexPhaseGitClient = { createWorktree: vi.fn(async () => { throw new Error('worktree failed'); }) };
    const codex: CodexPhaseCodexClient = { run: vi.fn(async () => ({ ok: true, finalText: 'done', exitCode: 0, timedOut: false })) };

    const result = await runCodexPhase({ homeDir, runId: run.run_id, profile: profile(), prompt: 'Do work', branch: 'symphony/ENG-1', baseRef: 'origin/main', git, codex });

    expect(result).toEqual({ ok: false, reason: 'worktree_creation_failed' });
    expect(codex.run).not.toHaveBeenCalled();
    const updated = await readRunById(homeDir, run.run_id);
    expect(updated.status).toBe('failed');
    expect(updated.reason).toBe('worktree_creation_failed');
  });
});
