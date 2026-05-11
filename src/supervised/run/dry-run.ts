import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LinearReadAdapter, type LinearIssue } from '../adapters/linear.js';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_SUCCEEDED } from '../exit-codes.js';
import { loadSupervisedProfile } from '../profile/loader.js';
import type { SupervisedProfile } from '../profile/types.js';
import { buildPrompt } from '../prompt/build.js';
import { redactShareableText } from '../safety/redaction.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';
import { appendEvent, createRunRecord, readRunById, updateRunJson } from '../run-record/store.js';
import { transitionRun } from '../run-record/state-machine.js';
import type { ArtifactsManifest, RunArtifact, RunReason, RunRecord } from '../run-record/types.js';

export interface DryRunLinearClient {
  findEligibleIssues(profile: SupervisedProfile): Promise<LinearIssue[]>;
  getIssueByKey?(key: string, profile: SupervisedProfile): Promise<LinearIssue | null>;
}

export interface RunDryRunOptions {
  profileName: string;
  homeDir: string;
  issueKey?: string;
  linear?: DryRunLinearClient;
  now?: Date;
}

export interface RunDryRunResult {
  exitCode: number;
  run: RunRecord;
  message: string;
}

export async function runDryRun(opts: RunDryRunOptions): Promise<RunDryRunResult> {
  const loaded = loadSupervisedProfile(opts.profileName, { homeDir: opts.homeDir });
  if (loaded.ok === false) {
    throw loaded.error;
  }
  const createRunOptions = {
    homeDir: opts.homeDir,
    profileName: loaded.profile.name,
    profileHash: loaded.resolvedHash,
    issueKey: opts.issueKey ?? null,
    mutating: false,
    ...(opts.now ? { now: opts.now } : {}),
  };
  const run = await createRunRecord(createRunOptions);
  const linear = opts.linear ?? new LinearReadAdapter();
  const candidates = opts.issueKey ? (await getByIssueKey(linear, loaded.profile, opts.issueKey)) : await linear.findEligibleIssues(loaded.profile);

  if (candidates.length !== 1) {
    const reason: RunReason = candidates.length === 0 ? (opts.issueKey ? 'issue_not_eligible' : 'no_candidates') : 'multiple_candidates';
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony dry run refused\n\nReason: ${reason}\n`);
    await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'refused', reason);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA, run: await readRunById(opts.homeDir, run.run_id), message: `Dry run refused: ${reason}` };
  }

  const issue = candidates[0];
  if (!issue) throw new Error('expected selected issue');
  const selectedRun = { ...run, issue_key: issue.key, updated_at: new Date().toISOString() };
  await updateRunJson(run.run_dir, selectedRun);
  const prompt = await buildPrompt({ profile: loaded.profile, issue, runId: run.run_id, dryRun: true, runDir: run.run_dir });
  const artifacts: RunArtifact[] = [
    { path: path.join(run.run_dir, 'linear-issue.json'), visibility: 'local_only', kind: 'linear_issue_json' },
    { path: path.join(run.run_dir, 'linear-issue.md'), visibility: 'redacted_shareable', kind: 'linear_issue_markdown' },
    { path: path.join(run.run_dir, 'prompt.md'), visibility: 'local_only', kind: 'prompt' },
    { path: path.join(run.run_dir, 'pr-body.preview.md'), visibility: 'github_visible', kind: 'pr_body_preview' },
    { path: path.join(run.run_dir, 'linear-claim.preview.md'), visibility: 'linear_visible', kind: 'linear_claim_preview' },
    { path: path.join(run.run_dir, 'result.md'), visibility: 'redacted_shareable', kind: 'result' },
  ];
  const issueMarkdown = redactShareableText(renderIssueMarkdown(issue));
  const prPreview = redactShareableText(renderPrPreview(issue, run.run_id));
  const linearClaimPreview = redactShareableText(renderLinearClaimPreview(issue, run.run_id));
  await writeJsonAtomic(path.join(run.run_dir, 'linear-issue.json'), issue);
  await writeFileAtomic(path.join(run.run_dir, 'linear-issue.md'), issueMarkdown);
  await writeFileAtomic(path.join(run.run_dir, 'prompt.md'), prompt.prompt);
  await writeFileAtomic(path.join(run.run_dir, 'pr-body.preview.md'), prPreview);
  await writeFileAtomic(path.join(run.run_dir, 'linear-claim.preview.md'), linearClaimPreview);
  await writeFileAtomic(path.join(run.run_dir, 'result.md'), redactShareableText(`# Dry run complete\n\nSelected issue: ${issue.key}\nRun ID: ${run.run_id}\n`));
  await writeJsonAtomic(path.join(run.run_dir, 'artifacts.json'), { schema_version: 1, run_id: run.run_id, artifacts } satisfies ArtifactsManifest);
  await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: run.run_id, timestamp: new Date().toISOString(), type: 'artifact', data: { included_instruction_files: prompt.includedInstructionFiles } });
  await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'dry_run', null);
  return { exitCode: EXIT_SUCCEEDED, run: await readRunById(opts.homeDir, run.run_id), message: `Dry run complete: ${issue.key}` };
}

async function getByIssueKey(linear: DryRunLinearClient, profile: SupervisedProfile, issueKey: string): Promise<LinearIssue[]> {
  if (linear.getIssueByKey) {
    const issue = await linear.getIssueByKey(issueKey, profile);
    return issue ? [issue] : [];
  }
  return (await linear.findEligibleIssues(profile)).filter((issue) => issue.key === issueKey);
}

function renderIssueMarkdown(issue: LinearIssue): string {
  return [`# ${issue.key}: ${issue.title}`, '', `URL: ${issue.url}`, `Status: ${issue.status}`, '', '## Description', issue.description || '(none)', '', '## Comments', issue.comments.length ? issue.comments.map((comment) => `- ${comment}`).join('\n') : '(none)'].join('\n');
}

function renderPrPreview(issue: LinearIssue, runId: string): string {
  return [`# ${issue.key}: ${issue.title}`, '', `Symphony dry-run preview for ${issue.key}.`, '', 'DRY RUN — NOT POSTED', '', `Run ID: ${runId}`, '', '<!-- symphony:status:start -->', 'Dry run only — no branch, commits, PR, CI, or Linear mutation performed.', '<!-- symphony:status:end -->'].join('\n');
}

function renderLinearClaimPreview(issue: LinearIssue, runId: string): string {
  return `Symphony dry run would claim ${issue.key} for supervised implementation.\n\nDRY RUN — NOT POSTED\n\nRun ID: ${runId}\nNo Linear mutation was performed.\n`;
}
