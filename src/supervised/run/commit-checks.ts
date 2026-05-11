import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, CommitInfo } from '../adapters/git.js';
import { GitAdapter } from '../adapters/git.js';
import type { SupervisedProfile } from '../profile/types.js';
import { appendEvent, readRunById } from '../run-record/store.js';
import { transitionRun } from '../run-record/state-machine.js';
import type { ArtifactsManifest, RunArtifact, RunReason } from '../run-record/types.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';
import { evaluateChangePolicy, type ChangePolicyFinding } from './change-policy.js';

export interface CommitChecksGitClient {
  newCommits(repoPath: string, baseSha: string, headRef: string): Promise<CommitInfo[]>;
  changedFiles(repoPath: string, baseSha: string, headRef: string): Promise<ChangedFile[]>;
  statusPorcelain(repoPath: string): Promise<string>;
}

export interface CheckCodexChangesOptions {
  homeDir: string;
  runId: string;
  profile: SupervisedProfile;
  worktreePath: string;
  baseSha: string;
  headRef?: string;
  git?: CommitChecksGitClient;
  now?: Date;
}

export interface CommitFinding {
  code: 'missing_issue_key' | 'author_domain_not_allowed' | 'forbidden_author_email';
  sha: string;
  message: string;
}

export interface DiffSummary {
  schema_version: 1;
  run_id: string;
  issue_key: string | null;
  base_sha: string;
  head_ref: string;
  commits: CommitInfo[];
  changed_files: ChangedFile[];
  commit_findings: CommitFinding[];
  policy_findings: ChangePolicyFinding[];
}

export type CheckCodexChangesResult = { ok: true; summary: DiffSummary } | { ok: false; reason: RunReason; summary: DiffSummary };

export async function checkCodexChanges(opts: CheckCodexChangesOptions): Promise<CheckCodexChangesResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  const git = opts.git ?? new GitAdapter();
  const headRef = opts.headRef ?? 'HEAD';
  const now = opts.now ?? new Date();

  const commits = await git.newCommits(opts.worktreePath, opts.baseSha, headRef);
  const changedFiles = await git.changedFiles(opts.worktreePath, opts.baseSha, headRef);
  const commitFindings = evaluateCommitPolicy(commits, run.issue_key, opts.profile);
  const policy = await evaluateChangePolicy(opts.worktreePath, changedFiles, opts.profile.change_policy);

  const summary: DiffSummary = {
    schema_version: 1,
    run_id: run.run_id,
    issue_key: run.issue_key,
    base_sha: opts.baseSha,
    head_ref: headRef,
    commits,
    changed_files: changedFiles,
    commit_findings: commitFindings,
    policy_findings: policy.findings,
  };
  await writeDiffSummaryArtifacts(run.run_dir, run.run_id, summary, now);

  if (commits.length === 0) return fail(opts, 'no_commit', summary, now);
  const status = await git.statusPorcelain(opts.worktreePath);
  if (status.trim().length > 0) return fail(opts, 'dirty_worktree_after_codex', summary, now);
  if (commitFindings.length > 0) return fail(opts, 'commit_message_policy_failed', summary, now);
  if (!policy.ok) return fail(opts, 'change_policy_failed', summary, now);

  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: run.run_id,
    timestamp: now.toISOString(),
    type: 'side_effect',
    data: { side_effect: 'codex_changes_checked', commit_count: commits.length, changed_file_count: changedFiles.length },
  });
  return { ok: true, summary };
}

function evaluateCommitPolicy(commits: CommitInfo[], issueKey: string | null, profile: SupervisedProfile): CommitFinding[] {
  const findings: CommitFinding[] = [];
  for (const commit of commits) {
    if (issueKey && !`${commit.subject}\n${commit.body}`.includes(issueKey)) {
      findings.push({ code: 'missing_issue_key', sha: commit.sha, message: `Commit subject must include ${issueKey}` });
    }
    for (const [role, rawEmail] of [['author', commit.authorEmail], ['committer', commit.committerEmail]] as const) {
      const email = rawEmail.toLowerCase();
      if (profile.git.forbid_author_emails.map((value) => value.toLowerCase()).includes(email)) {
        findings.push({ code: 'forbidden_author_email', sha: commit.sha, message: `Commit ${role} ${rawEmail} is forbidden` });
      }
      if (profile.git.require_author_email_domains.length > 0) {
        const allowed = profile.git.require_author_email_domains.some((domain) => email.endsWith(`@${domain.toLowerCase()}`));
        if (!allowed) {
          findings.push({ code: 'author_domain_not_allowed', sha: commit.sha, message: `Commit ${role} ${rawEmail} is outside allowed domains` });
        }
      }
    }
  }
  return findings;
}

async function fail(opts: CheckCodexChangesOptions, reason: RunReason, summary: DiffSummary, now: Date): Promise<CheckCodexChangesResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', reason, now);
  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: opts.runId,
    timestamp: now.toISOString(),
    type: 'warning',
    data: { reason, commit_findings: summary.commit_findings, policy_findings: summary.policy_findings },
  });
  return { ok: false, reason, summary };
}

async function writeDiffSummaryArtifacts(runDir: string, runId: string, summary: DiffSummary, now: Date): Promise<void> {
  const jsonPath = path.join(runDir, 'diff-summary.json');
  const markdownPath = path.join(runDir, 'diff-summary.md');
  await writeJsonAtomic(jsonPath, summary);
  await writeFileAtomic(markdownPath, renderDiffSummaryMarkdown(summary));
  await addArtifacts(runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'diff_summary_json' },
    { path: markdownPath, visibility: 'redacted_shareable', kind: 'diff_summary_markdown' },
  ]);
  await appendEvent(runDir, { schema_version: 1, event_id: randomUUID(), run_id: runId, timestamp: now.toISOString(), type: 'artifact', data: { artifacts: ['diff-summary.json', 'diff-summary.md'] } });
}

function renderDiffSummaryMarkdown(summary: DiffSummary): string {
  const lines = [
    '# Diff Summary',
    '',
    `Run: ${summary.run_id}`,
    `Issue: ${summary.issue_key ?? '(none)'}`,
    `Base SHA: ${summary.base_sha}`,
    `Head ref: ${summary.head_ref}`,
    '',
    '## Commits',
  ];
  if (summary.commits.length === 0) lines.push('- None');
  for (const commit of summary.commits) lines.push(`- ${commit.sha.slice(0, 12)} ${commit.subject}`);
  lines.push('', '## Changed files');
  if (summary.changed_files.length === 0) lines.push('- None');
  for (const file of summary.changed_files) lines.push(`- ${file.status} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path}`);
  lines.push('', '## Findings');
  const findings = [...summary.commit_findings, ...summary.policy_findings];
  if (findings.length === 0) lines.push('- None');
  for (const finding of findings) lines.push(`- ${finding.code}: ${sanitizeShareableText(finding.message)}`);
  return sanitizeShareableText(`${lines.join('\n')}\n`);
}

function sanitizeShareableText(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]');
}

async function addArtifacts(runDir: string, newArtifacts: RunArtifact[]): Promise<void> {
  const artifactsPath = path.join(runDir, 'artifacts.json');
  const manifest = JSON.parse(await readFile(artifactsPath, 'utf8')) as ArtifactsManifest;
  const byPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of newArtifacts) byPath.set(artifact.path, artifact);
  await writeJsonAtomic(artifactsPath, { ...manifest, artifacts: [...byPath.values()] });
}
