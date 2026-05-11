import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LinearIssue } from '../adapters/linear.js';
import type { SupervisedProfile } from '../profile/types.js';
import { appendEvent, readRunById } from '../run-record/store.js';
import { transitionRun } from '../run-record/state-machine.js';
import type { ArtifactsManifest, RunArtifact, RunReason } from '../run-record/types.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';

export interface ClaimLinearClient {
  resolveAssigneeId(profile: SupervisedProfile): Promise<string>;
  claimIssue(opts: { issueId: string; profile: SupervisedProfile; assigneeId: string }): Promise<void>;
  updateIssueStatus?(opts: { issueId: string; profile: SupervisedProfile; statusName: string }): Promise<void>;
  postComment(issueId: string, body: string): Promise<void>;
  getIssueById(issueId: string, profile: SupervisedProfile): Promise<LinearIssue | null>;
}

export interface ClaimSelectedIssueOptions {
  homeDir: string;
  runId: string;
  profile: SupervisedProfile;
  issue: LinearIssue;
  linear: ClaimLinearClient;
  now?: Date;
}

export type ClaimSelectedIssueResult = { ok: true; assigneeId: string; issue: LinearIssue } | { ok: false; reason: RunReason };

export async function claimSelectedIssue(opts: ClaimSelectedIssueOptions): Promise<ClaimSelectedIssueResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  const now = opts.now ?? new Date();

  const preClaimIssue = await opts.linear.getIssueById(opts.issue.id, opts.profile);
  if (!isStillEligibleForClaim(preClaimIssue, opts.issue, opts.profile)) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'refused', 'issue_changed_before_claim', now);
    return { ok: false, reason: 'issue_changed_before_claim' };
  }

  const assigneeId = await opts.linear.resolveAssigneeId(opts.profile);
  await opts.linear.claimIssue({ issueId: opts.issue.id, profile: opts.profile, assigneeId });
  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: opts.runId,
    timestamp: now.toISOString(),
    type: 'side_effect',
    data: { side_effect: 'linear_issue_claimed', issue_id: opts.issue.id, issue_key: opts.issue.key, assignee_id: assigneeId, status: opts.profile.linear.claim_status },
  });
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'claimed', null, now);

  const claimComment = renderClaimComment({ issue: opts.issue, runDir: run.run_dir, runId: opts.runId });
  const claimArtifactPath = path.join(run.run_dir, 'linear-claim.md');
  await writeFileAtomic(claimArtifactPath, claimComment);
  await addArtifact(run.run_dir, { path: claimArtifactPath, visibility: 'linear_visible', kind: 'linear_claim' });
  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: opts.runId,
    timestamp: now.toISOString(),
    type: 'artifact',
    data: { artifact: 'linear-claim.md', visibility: 'linear_visible', kind: 'linear_claim' },
  });

  await opts.linear.postComment(opts.issue.id, claimComment);
  await appendEvent(run.run_dir, {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: opts.runId,
    timestamp: now.toISOString(),
    type: 'side_effect',
    data: { side_effect: 'linear_claim_comment_posted', issue_id: opts.issue.id, issue_key: opts.issue.key },
  });

  const verified = await opts.linear.getIssueById(opts.issue.id, opts.profile);
  if (!verified || verified.status !== opts.profile.linear.claim_status || verified.assigneeId !== assigneeId) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'claim_verification_failed', now);
    return { ok: false, reason: 'claim_verification_failed' };
  }

  return { ok: true, assigneeId, issue: verified };
}

function isStillEligibleForClaim(current: LinearIssue | null, selected: LinearIssue, profile: SupervisedProfile): boolean {
  if (!current) return false;
  if (current.id !== selected.id || current.key !== selected.key) return false;
  if (current.status !== profile.linear.eligible_status) return false;
  if (current.teamKey !== profile.linear.team) return false;
  if (profile.linear.project !== null && current.projectName !== profile.linear.project) return false;
  if (profile.linear.require_unassigned && current.assigneeId !== null) return false;
  return profile.linear.required_labels.every((label) => current.labels.includes(label));
}

async function addArtifact(runDir: string, artifact: RunArtifact): Promise<void> {
  const artifactsPath = path.join(runDir, 'artifacts.json');
  const manifest = JSON.parse(await readFile(artifactsPath, 'utf8')) as ArtifactsManifest;
  const artifacts = manifest.artifacts.filter((existing) => existing.path !== artifact.path);
  artifacts.push(artifact);
  await writeJsonAtomic(artifactsPath, { ...manifest, artifacts });
}

function renderClaimComment(opts: { issue: LinearIssue; runId: string; runDir: string }): string {
  return [
    `Symphony claimed ${opts.issue.key} for supervised implementation.`,
    '',
    `Run ID: ${opts.runId}`,
    `Run record: ${opts.runDir}`,
    '',
    'If this run fails after claim, Symphony will leave the issue assigned/in-progress and post a failure comment.',
  ].join('\n');
}
