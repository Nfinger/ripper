import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { GitAdapter } from '../adapters/git.js';
import { LinearReadAdapter, type LinearIssue } from '../adapters/linear.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GitHubCliAdapter, type CreatePullRequestOptions, type GitHubCheckRun, type PostPullRequestCommentOptions, type PullRequestResult, type WaitForChecksOptions, type WaitForChecksResult } from '../adapters/github.js';
import { runCommand } from '../command-runner/runner.js';
import type { CommandResult, RunCommandOptions } from '../command-runner/types.js';
import { EXIT_CODEX_FAILED, EXIT_CONFIG_OR_SCHEMA, EXIT_LOCK_EXISTS, EXIT_PREFLIGHT_FAILED, EXIT_REFUSED, EXIT_SUCCEEDED } from '../exit-codes.js';
import { acquireRepoLock, acquireScopedLock, releaseRepoLock, releaseScopedLock, withRepoOperationLock, withScopedOperationLock } from '../locks/store.js';
import { loadSupervisedProfile } from '../profile/loader.js';
import type { SupervisedProfile, ValidationCommand } from '../profile/types.js';
import { buildPrompt } from '../prompt/build.js';
import { appendEvent, createRunRecord, readRunById, updateRunJson } from '../run-record/store.js';
import { transitionRun } from '../run-record/state-machine.js';
import type { ArtifactsManifest, RunArtifact, RunReason, RunRecord } from '../run-record/types.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';
import { redactShareableText, scanPublicContent } from '../safety/redaction.js';
import { checkCodexChanges, type CommitChecksGitClient } from './commit-checks.js';
import { runCodexPhase, type CodexPhaseCodexClient, type CodexPhaseGitClient } from './codex-phase.js';
import { claimSelectedIssue, type ClaimLinearClient } from './claim.js';
import { runPreflight, type CodexPreflightClient, type GitHubPreflightClient, type GitPreflightClient, type LinearPreflightClient, type PreflightResult } from './preflight.js';

export interface RealRunGitClient extends GitPreflightClient, CodexPhaseGitClient, CommitChecksGitClient {
  remoteBaseSha(repoPath: string, remote: string, base: string): Promise<string>;
  pushBranch(worktreePath: string, remote: string, branch: string): Promise<void>;
}

export interface RealRunGitHubClient extends GitHubPreflightClient {
  createPullRequest(opts: CreatePullRequestOptions): Promise<PullRequestResult>;
  postPullRequestComment(opts: PostPullRequestCommentOptions): Promise<void>;
  waitForChecks(opts: WaitForChecksOptions): Promise<WaitForChecksResult>;
}

export interface RealRunLinearClient extends ClaimLinearClient, LinearPreflightClient {
  findEligibleIssues(profile: SupervisedProfile): Promise<LinearIssue[]>;
  getIssueByKey?(key: string, profile: SupervisedProfile): Promise<LinearIssue | null>;
  updateIssueStatus(opts: { issueId: string; profile: SupervisedProfile; statusName: string }): Promise<void>;
}

export interface RealRunClients {
  git: RealRunGitClient;
  linear: RealRunLinearClient;
  github: RealRunGitHubClient;
  codexReadiness: CodexPreflightClient;
  codex: CodexPhaseCodexClient;
  reviewer: CodexPhaseCodexClient;
  validation: ValidationRunnerClient;
}

export interface ValidationRunnerClient {
  run(opts: RunCommandOptions): Promise<CommandResult>;
}

export interface RunRealRunOptions {
  profileName: string;
  homeDir: string;
  issueKey?: string;
  clients?: Partial<RealRunClients>;
  now?: Date;
}

export interface ResumeRealRunOptions {
  profileName: string;
  homeDir: string;
  runId: string;
  clients?: Partial<RealRunClients>;
}

export interface RunRealRunResult {
  exitCode: number;
  run: RunRecord;
  message: string;
}

export async function resumeRealRun(opts: ResumeRealRunOptions): Promise<RunRealRunResult> {
  const loaded = loadSupervisedProfile(opts.profileName, { homeDir: opts.homeDir });
  if (loaded.ok === false) throw loaded.error;
  const profile = loaded.profile;
  const clients = buildClients(opts.clients);
  const run = await readRunById(opts.homeDir, opts.runId);

  let lockAcquired = false;
  try {
    const lock = await acquireRepoLock({ homeDir: opts.homeDir, repoPath: profile.repo.path, runId: run.run_id, reason: `symphony resume ${run.run_id}` });
    if (!lock.ok) {
      return { exitCode: EXIT_LOCK_EXISTS, run, message: 'Resume refused: repo lock exists' };
    }
    lockAcquired = true;
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: run.run_id, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'repo_lock_acquired_for_resume', repo_path: lock.lock.repo_path, lock_id: lock.lock.lock_id } });

    if (run.profile_name !== profile.name || !run.mutating) {
      return failResumeIntegrity({ homeDir: opts.homeDir, run, reasonDetail: 'Run profile or mutating flag does not match resume request' });
    }
    if (run.profile_hash !== loaded.resolvedHash) {
      return failResumeIntegrity({ homeDir: opts.homeDir, run, reasonDetail: 'Run profile hash does not match current profile definition' });
    }
    const canRetryPrCreation = run.status === 'failed' && run.reason === 'pr_creation_failed';
    if (!canRetryPrCreation && run.status !== 'pr_created' && run.status !== 'ci_running' && run.status !== 'ci_completed') {
      return failResumeIntegrity({ homeDir: opts.homeDir, run, reasonDetail: `Run status ${run.status} is not resumable by this slice` });
    }

    let issue: LinearIssue | null = null;
    try {
      issue = await resolveResumeIssue({ run, profile, linear: clients.linear });
    } catch (error) {
      return failResumeIntegrity({ homeDir: opts.homeDir, run: await readRunById(opts.homeDir, run.run_id), reasonDetail: `Could not resolve Linear issue for resumed run: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!issue) return failResumeIntegrity({ homeDir: opts.homeDir, run: await readRunById(opts.homeDir, run.run_id), reasonDetail: 'Could not resolve Linear issue for resumed run' });
    const expectedBranch = branchName(profile.name, issue.key, 'implementation');
    if (canRetryPrCreation) {
      const symphonyDir = path.dirname(path.dirname(run.run_dir));
      const worktreePath = path.join(symphonyDir, 'worktrees', run.run_id);
      return runHandoffPhase({ homeDir: opts.homeDir, runId: run.run_id, profile, issue, branch: expectedBranch, worktreePath, git: clients.git, github: clients.github, linear: clients.linear });
    }
    const pr = await readPrMetadata({ runDir: run.run_dir, runId: run.run_id, expectedBase: profile.repo.base_branch, expectedHead: expectedBranch });
    if (!pr) return failResumeIntegrity({ homeDir: opts.homeDir, run: await readRunById(opts.homeDir, run.run_id), reasonDetail: 'Missing or invalid pr.json for resumed run' });
    const branch = pr.head;

    if (run.status === 'ci_completed') {
      return runLinearSuccessHandoff({ homeDir: opts.homeDir, runId: run.run_id, profile, issue, branch, linear: clients.linear, pr });
    }
    return runCiPhase({ homeDir: opts.homeDir, runId: run.run_id, profile, issue, branch, worktreePath: profile.repo.path, github: clients.github, linear: clients.linear, pr, alreadyCiRunning: run.status === 'ci_running' });
  } finally {
    if (lockAcquired) await releaseRepoLock({ homeDir: opts.homeDir, repoPath: profile.repo.path, runId: run.run_id, reason: 'resume finished' });
  }
}

export async function runRealRun(opts: RunRealRunOptions): Promise<RunRealRunResult> {
  const loaded = loadSupervisedProfile(opts.profileName, { homeDir: opts.homeDir });
  if (loaded.ok === false) throw loaded.error;

  const profile = loaded.profile;
  const run = await createRunRecord({
    homeDir: opts.homeDir,
    profileName: profile.name,
    profileHash: loaded.resolvedHash,
    issueKey: opts.issueKey ?? null,
    mutating: true,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const clients = buildClients(opts.clients);
  const targetBranch = opts.issueKey ? branchName(profile.name, opts.issueKey, 'implementation') : `symphony/${safeSegment(profile.name)}/${run.run_id}`;

  let issueLockScope: string | null = null;
  let issueLockAcquired = false;
  try {
    const candidates = opts.issueKey ? await getByIssueKey(clients.linear, profile, opts.issueKey) : await clients.linear.findEligibleIssues(profile);
    if (candidates.length !== 1) {
      const reason: RunReason = candidates.length === 0 ? (opts.issueKey ? 'issue_not_eligible' : 'no_candidates') : 'multiple_candidates';
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony run refused\n\nReason: ${reason}\n`);
      await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'refused', reason);
      return { exitCode: EXIT_REFUSED, run: await readRunById(opts.homeDir, run.run_id), message: `Run refused: ${reason}` };
    }
    const issue = candidates[0];
    if (!issue) throw new Error('expected selected issue');
    issueLockScope = issueLockScopeFor(profile.name, issue.key);
    const issueLock = await acquireScopedLock({ homeDir: opts.homeDir, scope: issueLockScope, runId: run.run_id, reason: `symphony issue run ${issue.key}` });
    if (!issueLock.ok) {
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony run refused\n\nReason: issue_lock_exists\n');
      await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'refused', 'lock_exists');
      return { exitCode: EXIT_LOCK_EXISTS, run: await readRunById(opts.homeDir, run.run_id), message: 'Run refused: issue lock exists' };
    }
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: run.run_id, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'issue_lock_acquired', scope: issueLock.lock.scope, lock_id: issueLock.lock.lock_id } });
    issueLockAcquired = true;
    const actualBranch = branchName(profile.name, issue.key, 'implementation');
    await updateRunJson(run.run_dir, { ...(await readRunById(opts.homeDir, run.run_id)), issue_key: issue.key, updated_at: new Date().toISOString() });

    await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'preflight_running');
    const preflight = await withRepoOperationLock(opts.homeDir, profile.repo.path, () => runPreflight({ profile, targetBranch: actualBranch, git: clients.git, github: clients.github, linear: clients.linear, codex: clients.codexReadiness }));
    await writePreflightArtifacts(run.run_dir, run.run_id, preflight);
    if (!preflight.ok) {
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony preflight failed\n\nFailures: ${preflight.failures.join(', ') || '(unknown)'}\n`);
      await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'preflight_failed', null);
      return { exitCode: EXIT_PREFLIGHT_FAILED, run: await readRunById(opts.homeDir, run.run_id), message: `Preflight failed: ${preflight.failures.join(', ')}` };
    }

    await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'candidate_selected');
    let claim;
    try {
      claim = await claimSelectedIssue({ homeDir: opts.homeDir, runId: run.run_id, profile, issue, linear: clients.linear });
    } catch (error) {
      const current = await readRunById(opts.homeDir, run.run_id);
      const reason: RunReason = 'post_claim_unhandled_error';
      if (current.status === 'claimed') await transitionRun({ homeDir: opts.homeDir }, run.run_id, 'failed', reason);
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: run.run_id, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'claim_stage_unhandled_error', error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
      if (current.status === 'claimed' || current.status === 'failed') await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony claim step failed\n\nReason: ${reason}\n`);
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, run.run_id), message: `Claim step failed: ${reason}` };
    }
    if (!claim.ok) {
      const reason = (claim as { ok: false; reason: RunReason }).reason;
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony run stopped\n\nReason: ${reason}\n`);
      const updated = await readRunById(opts.homeDir, run.run_id);
      if (updated.status === 'failed') await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
      return { exitCode: updated.status === 'refused' ? EXIT_REFUSED : EXIT_CONFIG_OR_SCHEMA, run: await readRunById(opts.homeDir, run.run_id), message: `Run stopped: ${reason}` };
    }

    const postClaimResult = await runPostClaimCodexSlice({ opts, run, profile, issue, actualBranch, clients });
    return postClaimResult;
  } finally {
    if (issueLockScope && issueLockAcquired) {
      await releaseScopedLock({ homeDir: opts.homeDir, scope: issueLockScope, runId: run.run_id, reason: 'run finished' });
    }
  }
}

async function failResumeIntegrity(opts: { homeDir: string; run: RunRecord; reasonDetail: string }): Promise<RunRealRunResult> {
  const current = await readRunById(opts.homeDir, opts.run.run_id);
  if (current.status === 'pr_created' || current.status === 'ci_running' || current.status === 'ci_completed') {
    await transitionRun({ homeDir: opts.homeDir }, opts.run.run_id, 'failed', 'resume_integrity_check_failed');
  }
  const latest = await readRunById(opts.homeDir, opts.run.run_id);
  await appendEvent(opts.run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.run.run_id, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'resume_integrity_check_failed', detail: redactShareableText(opts.reasonDetail) } });
  await writeFileAtomic(path.join(opts.run.run_dir, 'result.md'), ['# Symphony resume failed', '', 'Reason: resume_integrity_check_failed', `Detail: ${redactShareableText(opts.reasonDetail)}`, ''].join('\n'));
  return { exitCode: EXIT_CONFIG_OR_SCHEMA, run: latest, message: 'Resume failed: resume_integrity_check_failed' };
}

async function resolveResumeIssue(opts: { run: RunRecord; profile: SupervisedProfile; linear: RealRunLinearClient }): Promise<LinearIssue | null> {
  const claimedIssueId = await readClaimedIssueId(opts.run.run_dir);
  const byClaimedId = claimedIssueId ? await opts.linear.getIssueById(claimedIssueId, opts.profile) : null;
  const byKey = opts.run.issue_key && opts.linear.getIssueByKey ? await opts.linear.getIssueByKey(opts.run.issue_key, opts.profile) : null;
  if (byClaimedId && byKey && (byClaimedId.id !== byKey.id || byClaimedId.key !== byKey.key)) return null;
  if (byClaimedId && opts.run.issue_key && byClaimedId.key !== opts.run.issue_key) return null;
  if (byClaimedId) return byClaimedId;
  return byKey;
}

async function readClaimedIssueId(runDir: string): Promise<string | null> {
  const raw = await readOptionalFile(path.join(runDir, 'events.jsonl'));
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { data?: { side_effect?: unknown; issue_id?: unknown } };
      if (event.data?.side_effect === 'linear_issue_claimed' && typeof event.data.issue_id === 'string') return event.data.issue_id;
    } catch {
      // Ignore corrupt historical event lines; the integrity check will fail if no issue can be resolved.
    }
  }
  return null;
}

async function readPrMetadata(opts: { runDir: string; runId: string; expectedBase: string; expectedHead: string }): Promise<(PullRequestResult & { head: string }) | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(opts.runDir, 'pr.json'), 'utf8')) as { number?: unknown; url?: unknown; head?: unknown; base?: unknown; run_id?: unknown };
    if (typeof raw.number !== 'number' || typeof raw.url !== 'string') return null;
    if (raw.run_id !== opts.runId) return null;
    if (raw.base !== opts.expectedBase) return null;
    if (raw.head !== opts.expectedHead) return null;
    return { number: raw.number, url: raw.url, head: raw.head };
  } catch {
    return null;
  }
}

async function runPostClaimCodexSlice(opts: { opts: RunRealRunOptions; run: RunRecord; profile: SupervisedProfile; issue: LinearIssue; actualBranch: string; clients: RealRunClients }): Promise<RunRealRunResult> {
  const { run, profile, issue, actualBranch, clients } = opts;
  try {
    const baseShaResult = await withRepoOperationLock(opts.opts.homeDir, profile.repo.path, () => getRemoteBaseShaOrFail({ opts: opts.opts, run, profile, issue, git: clients.git, linear: clients.linear }));
    if (baseShaResult.ok === false) return baseShaResult.result;
    const baseSha = baseShaResult.baseSha;
    const prompt = await buildPrompt({ profile, issue, runId: run.run_id, dryRun: false, runDir: run.run_dir });
    const codex = await runCodexPhase({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, prompt: prompt.prompt, branch: actualBranch, baseRef: `${profile.repo.remote}/${profile.repo.base_branch}`, git: clients.git, codex: clients.codex, withGitOperationLock: (fn) => withRepoOperationLock(opts.opts.homeDir, profile.repo.path, fn) });
    if (!codex.ok) {
      const reason = (codex as { ok: false; reason: RunReason }).reason;
      await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony Codex phase failed\n\nReason: ${reason}\n`);
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Codex failed: ${reason}` };
    }

    let check = await checkCodexChanges({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, worktreePath: codex.worktreePath, baseSha, git: clients.git });
    if (!check.ok) {
      const reason = (check as { ok: false; reason: RunReason }).reason;
      await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony post-Codex checks failed\n\nReason: ${reason}\n`);
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Post-Codex checks failed: ${reason}` };
    }

    let fixAttempt = 0;
    while (true) {
      const review = await runAgentReviewPhase({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, issue, worktreePath: codex.worktreePath, codex: clients.reviewer, git: clients.git });
      if (review.ok === true) break;
      if (review.requestChanges === true && fixAttempt < profile.agent_review.max_fix_attempts) {
        fixAttempt += 1;
        const remediation = await runReviewRemediationPhase({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, issue, worktreePath: codex.worktreePath, codex: clients.codex, reviewText: review.reviewText, attempt: fixAttempt });
        if (remediation.ok === false) {
          await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason: remediation.reason });
          await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony review remediation failed\n\nReason: ${remediation.reason}\n`);
          return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Review remediation failed: ${remediation.reason}` };
        }
        check = await checkCodexChanges({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, worktreePath: codex.worktreePath, baseSha, git: clients.git });
        if (!check.ok) {
          const reason = (check as { ok: false; reason: RunReason }).reason;
          await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
          await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony post-remediation checks failed\n\nReason: ${reason}\n`);
          return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Post-remediation checks failed: ${reason}` };
        }
        continue;
      }
      const latest = await readRunById(opts.opts.homeDir, run.run_id);
      if (latest.status !== 'failed' && latest.status !== 'timed_out') {
        await transitionRun({ homeDir: opts.opts.homeDir }, run.run_id, 'failed', review.reason);
      }
      await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason: review.reason });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony agent review failed\n\nReason: ${review.reason}\n`);
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Agent review failed: ${review.reason}` };
    }

    const smoke = await runSmokeVerificationPhase({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, issue, worktreePath: codex.worktreePath, git: clients.git, verification: clients.validation, linear: clients.linear });
    if (smoke.ok === false) {
      await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason: smoke.reason });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony smoke verification failed\n\nReason: ${smoke.reason}\n`);
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Smoke verification failed: ${smoke.reason}` };
    }

    if (profile.validation.commands.length === 0) {
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony Codex slice complete', '', `Issue: ${issue.key}`, `Branch: ${actualBranch}`, `Worktree: ${codex.worktreePath}`, '', 'Agent review completed. Manual inspection required before validation, push, PR, CI, or Linear handoff.', ''].join('\n'));
      return { exitCode: EXIT_SUCCEEDED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Codex slice complete for ${issue.key}; manual inspection required` };
    }

    const validation = await runValidationPhase({ homeDir: opts.opts.homeDir, runId: run.run_id, profile, issue, branch: actualBranch, worktreePath: codex.worktreePath, git: clients.git, github: clients.github, validation: clients.validation, linear: clients.linear });
    return validation;
  } catch (error) {
    const reason: RunReason = 'post_claim_unhandled_error';
    const current = await readRunById(opts.opts.homeDir, run.run_id);
    if (current.status === 'claimed' || current.status === 'codex_running' || current.status === 'codex_completed' || current.status === 'code_review_running' || current.status === 'review_remediation_running' || current.status === 'review_remediation_completed' || current.status === 'code_review_completed' || current.status === 'verification_running' || current.status === 'verification_completed' || current.status === 'validation_running' || current.status === 'validation_completed' || current.status === 'handoff_running' || current.status === 'pr_created' || current.status === 'ci_running') {
      await transitionRun({ homeDir: opts.opts.homeDir }, run.run_id, 'failed', reason);
    }
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: run.run_id, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'post_claim_unhandled_error', error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
    await postFailureComment({ runDir: run.run_dir, runId: run.run_id, issue, linear: clients.linear, profile, reason });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), `# Symphony post-claim step failed\n\nReason: ${reason}\n`);
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, run.run_id), message: `Post-claim step failed: ${reason}` };
  }
}


type GateResult = { ok: true } | { ok: false; reason: RunReason };
type ReviewGateResult = { ok: true } | { ok: false; reason: RunReason; requestChanges?: false } | { ok: false; reason: 'code_review_failed'; requestChanges: true; reviewText: string };

async function runAgentReviewPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; worktreePath: string; codex: CodexPhaseCodexClient; git: RealRunGitClient }): Promise<ReviewGateResult> {
  if (!opts.profile.agent_review.enabled) return { ok: true };
  const run = await readRunById(opts.homeDir, opts.runId);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'code_review_running');
  const diffSummary = await readOptionalFile(path.join(run.run_dir, 'diff-summary.md'));
  const prompt = buildAgentReviewPrompt({ issue: opts.issue, diffSummary });
  const promptPath = path.join(run.run_dir, 'agent-review-prompt.md');
  const rawLogPath = path.join(run.run_dir, 'agent-review.log');
  const redactedLogPath = path.join(run.run_dir, 'agent-review.redacted.log');
  const finalPath = path.join(run.run_dir, 'agent-review.md');
  await writeFileAtomic(promptPath, prompt);
  await addArtifacts(run.run_dir, [
    { path: promptPath, visibility: 'local_only', kind: 'agent_review_prompt' },
    { path: rawLogPath, visibility: 'local_only', kind: 'agent_review_raw_log' },
    { path: redactedLogPath, visibility: 'redacted_shareable', kind: 'agent_review_redacted_log' },
  ]);
  const agent = { ...opts.profile.agent, command: opts.profile.agent_review.command, model: opts.profile.agent_review.model ?? opts.profile.agent.model, timeout_minutes: Math.max(1, Math.ceil(opts.profile.agent_review.timeout_seconds / 60)) };
  const result = await opts.codex.run({ cwd: opts.worktreePath, promptPath, rawLogPath, redactedLogPath, agent, recordEvent: async (event) => appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: `agent_review_${event.type}`, ...event.data } }) });
  if (!result.ok) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'code_review_failed');
    return { ok: false, reason: 'code_review_failed' };
  }
  await writeFileAtomic(finalPath, redactShareableText(result.finalText));
  await addArtifacts(run.run_dir, [{ path: finalPath, visibility: 'redacted_shareable', kind: 'agent_review_final' }]);
  await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['agent-review.md'] } });
  const verdict = parseReviewVerdict(result.finalText);
  const dirty = await opts.git.statusPorcelain(opts.worktreePath);
  if (dirty.trim().length > 0) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'dirty_worktree_after_review');
    return { ok: false, reason: 'dirty_worktree_after_review' };
  }
  if (verdict === 'REQUEST_CHANGES') {
    return { ok: false, reason: 'code_review_failed', requestChanges: true, reviewText: redactShareableText(result.finalText) };
  }
  if (verdict !== 'APPROVED') {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'code_review_failed');
    return { ok: false, reason: 'code_review_failed' };
  }
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'code_review_completed');
  return { ok: true };
}

function buildAgentReviewPrompt(opts: { issue: LinearIssue; diffSummary: string }): string {
  return [
    '# Symphony Required Agent Code Review',
    '',
    'You are a second, independent code-review agent. Review the committed diff only; do not edit files, commit, push, create PRs, or post external comments.',
    '',
    `Linear issue: ${opts.issue.key} ${opts.issue.title}`,
    '',
    '## Required checks',
    '- Acceptance criteria coverage: quote every concrete requirement from the Linear issue and map it to committed files, tests, or verification evidence.',
    '- Spec fit: implementation addresses the issue without scope creep.',
    '- Correctness: obvious logic, integration, migration, and edge-case issues.',
    '- Safety: no secrets, unsafe paths, auth leakage, or public-artifact leakage.',
    '- Tests: changed behavior is covered or the gap is clearly justified.',
    '- Documentation impact: verify that specs, ADRs, user flows, API/contract docs, runbooks, and developer docs in the target repo were updated when the committed behavior changed them.',
    '- Living docs policy: approved specs may supersede stale behavior docs, but the implementation must update those docs; hard security/compliance/architecture constraints require explicit authorization to change.',
    '- Test-only suspicion: if the diff only changes tests but the issue asks to fix, remove, wire, show, display, prevent, support, or expose operator/UI behavior, do not approve unless existing production code already satisfies every criterion and the tests prove that explicitly.',
    '- UI-state specificity: if the issue names visible states such as pending, succeeded, failed, or unavailable, the diff must implement or verify those exact states.',
    '',
    '## Diff summary',
    opts.diffSummary.trim() || '(No diff summary available.)',
    '',
    '## Output contract',
    'Put the verdict on the first non-empty line, starting with exactly one of:',
    '- APPROVED — no blocking issues found.',
    '- REQUEST_CHANGES — blocking issues found, followed by bullets.',
    '',
    'If you approve, you must also include this section:',
    'ACCEPTANCE_CRITERIA_COVERAGE:',
    '- [x] quoted criterion — evidence: changed file/test/manual check',
    '',
    'If any explicit criterion is missing or only partially covered, use REQUEST_CHANGES instead of APPROVED.',
    '',
  ].join('\n');
}

function parseReviewVerdict(text: string): 'APPROVED' | 'REQUEST_CHANGES' | 'INVALID' {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => line.toUpperCase());
  const firstLine = lines[0] ?? '';
  const lastLine = lines.at(-1) ?? '';
  const hasCoverage = hasAcceptanceCriteriaCoverage(text);
  if (firstLine.startsWith('APPROVED')) return hasCoverage ? 'APPROVED' : 'INVALID';
  if (firstLine.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  if (lastLine.startsWith('APPROVED')) return hasCoverage ? 'APPROVED' : 'INVALID';
  if (lastLine.startsWith('REQUEST_CHANGES')) return 'REQUEST_CHANGES';
  return 'INVALID';
}

function hasAcceptanceCriteriaCoverage(text: string): boolean {
  const normalized = text.toUpperCase();
  return normalized.includes('ACCEPTANCE_CRITERIA_COVERAGE:') && /\[[Xx]\]/u.test(text);
}

async function runReviewRemediationPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; worktreePath: string; codex: CodexPhaseCodexClient; reviewText: string; attempt: number }): Promise<GateResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'review_remediation_running');
  const diffSummary = await readOptionalFile(path.join(run.run_dir, 'diff-summary.md'));
  const prompt = buildReviewRemediationPrompt({ issue: opts.issue, reviewText: opts.reviewText, diffSummary, attempt: opts.attempt, maxAttempts: opts.profile.agent_review.max_fix_attempts });
  const prefix = `review-remediation-${opts.attempt}`;
  const promptPath = path.join(run.run_dir, `${prefix}-prompt.md`);
  const rawLogPath = path.join(run.run_dir, `${prefix}.log`);
  const redactedLogPath = path.join(run.run_dir, `${prefix}.redacted.log`);
  const finalPath = path.join(run.run_dir, `${prefix}-final.md`);
  await writeFileAtomic(promptPath, prompt);
  await addArtifacts(run.run_dir, [
    { path: promptPath, visibility: 'local_only', kind: 'review_remediation_prompt' },
    { path: rawLogPath, visibility: 'local_only', kind: 'review_remediation_raw_log' },
    { path: redactedLogPath, visibility: 'redacted_shareable', kind: 'review_remediation_redacted_log' },
  ]);
  const result = await opts.codex.run({ cwd: opts.worktreePath, promptPath, rawLogPath, redactedLogPath, agent: opts.profile.agent, recordEvent: async (event) => appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: `review_remediation_${event.type}`, attempt: opts.attempt, ...event.data } }) });
  if (!result.ok) {
    const reason = (result as { ok: false; reason: RunReason }).reason;
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, reason === 'codex_timeout' ? 'timed_out' : 'failed', reason);
    return { ok: false, reason };
  }
  await writeFileAtomic(finalPath, redactShareableText(result.finalText));
  await addArtifacts(run.run_dir, [{ path: finalPath, visibility: 'redacted_shareable', kind: 'review_remediation_final' }]);
  await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: [`${prefix}-prompt.md`, `${prefix}.log`, `${prefix}.redacted.log`, `${prefix}-final.md`] } });
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'review_remediation_completed');
  return { ok: true };
}

function buildReviewRemediationPrompt(opts: { issue: LinearIssue; reviewText: string; diffSummary: string; attempt: number; maxAttempts: number }): string {
  return [
    '# Symphony Review Remediation',
    '',
    'You are the implementation agent continuing the existing worktree after an independent reviewer requested changes.',
    'Address only the blocking review findings. Do not push, create PRs, or post external comments.',
    'Commit your remediation before exiting; the commit message must reference the Linear issue key.',
    '',
    `Linear issue: ${opts.issue.key} ${opts.issue.title}`,
    `Remediation attempt: ${opts.attempt} of ${opts.maxAttempts}`,
    '',
    '## Review findings to fix',
    opts.reviewText.trim() || '(No review text available.)',
    '',
    '## Current diff summary',
    opts.diffSummary.trim() || '(No diff summary available.)',
    '',
  ].join('\n');
}

async function runSmokeVerificationPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; worktreePath: string; git: RealRunGitClient; verification: ValidationRunnerClient; linear: RealRunLinearClient }): Promise<GateResult> {
  if (!opts.profile.verification.enabled) return { ok: true };
  const run = await readRunById(opts.homeDir, opts.runId);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'verification_running');
  const commands = opts.profile.verification.commands;
  const results: Array<{ name: string; status: 'passed' | 'failed'; exitCode: number; timedOut: boolean; durationMs: number; mode: string }> = [];
  if (commands.length === 0) {
    await writeVerificationSummary(run.run_dir, opts.runId, opts.profile.verification.mode, results);
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'smoke_verification_failed');
    return { ok: false, reason: 'smoke_verification_failed' };
  }
  for (const [index, command] of commands.entries()) {
    const rawLogPath = path.join(run.run_dir, `verification-${index + 1}-${safeSegment(command.name)}.log`);
    const redactedLogPath = path.join(run.run_dir, `verification-${index + 1}-${safeSegment(command.name)}.redacted.log`);
    const result = await opts.verification.run(buildValidationCommand(command, opts.worktreePath, rawLogPath, redactedLogPath));
    await addArtifacts(run.run_dir, [
      { path: rawLogPath, visibility: 'local_only', kind: 'verification_raw_log' },
      { path: redactedLogPath, visibility: 'redacted_shareable', kind: 'verification_redacted_log' },
    ]);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'smoke_verification_command_finished', name: command.name, mode: opts.profile.verification.mode, exit_code: result.exitCode, timed_out: result.timedOut, duration_ms: result.durationMs } });
    const status = result.exitCode === 0 && !result.timedOut && !result.finalizationError ? 'passed' : 'failed';
    results.push({ name: command.name, status, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, mode: opts.profile.verification.mode });
    if (status === 'failed') {
      await writeVerificationSummary(run.run_dir, opts.runId, opts.profile.verification.mode, results);
      await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'smoke_verification_failed');
      return { ok: false, reason: 'smoke_verification_failed' };
    }
  }
  const evidence = await collectVerificationEvidence({ runDir: run.run_dir, runId: opts.runId, worktreePath: opts.worktreePath, profile: opts.profile });
  if (!evidence.ok) {
    await writeVerificationSummary(run.run_dir, opts.runId, opts.profile.verification.mode, results, evidence.reason);
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'smoke_verification_failed');
    return { ok: false, reason: 'smoke_verification_failed' };
  }
  const dirty = await opts.git.statusPorcelain(opts.worktreePath);
  if (dirty.trim().length > 0) {
    await writeVerificationSummary(run.run_dir, opts.runId, opts.profile.verification.mode, results, dirty);
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'dirty_worktree_after_verification');
    return { ok: false, reason: 'dirty_worktree_after_verification' };
  }
  await writeVerificationSummary(run.run_dir, opts.runId, opts.profile.verification.mode, results);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'verification_completed');
  return { ok: true };
}

async function runValidationPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; branch: string; worktreePath: string; git: RealRunGitClient; github: RealRunGitHubClient; validation: ValidationRunnerClient; linear: RealRunLinearClient }): Promise<RunRealRunResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'validation_running');
  const results: Array<{ name: string; status: 'passed' | 'failed'; exitCode: number; timedOut: boolean; durationMs: number }> = [];
  for (const [index, command] of opts.profile.validation.commands.entries()) {
    const rawLogPath = path.join(run.run_dir, `validation-${index + 1}-${safeSegment(command.name)}.log`);
    const redactedLogPath = path.join(run.run_dir, `validation-${index + 1}-${safeSegment(command.name)}.redacted.log`);
    const commandOpts = buildValidationCommand(command, opts.worktreePath, rawLogPath, redactedLogPath);
    const result = await opts.validation.run(commandOpts);
    await addArtifacts(run.run_dir, [
      { path: rawLogPath, visibility: 'local_only', kind: 'validation_raw_log' },
      { path: redactedLogPath, visibility: 'redacted_shareable', kind: 'validation_redacted_log' },
    ]);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'validation_command_finished', name: command.name, exit_code: result.exitCode, timed_out: result.timedOut, duration_ms: result.durationMs } });
    const status = result.exitCode === 0 && !result.timedOut && !result.finalizationError ? 'passed' : 'failed';
    results.push({ name: command.name, status, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs });
    if (status === 'failed') {
      await writeValidationSummary(run.run_dir, opts.runId, results);
      await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'validation_failed');
      await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'validation_failed' });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony validation failed\n\nReason: validation_failed\n');
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'Validation failed: validation_failed' };
    }
  }

  const dirty = await opts.git.statusPorcelain(opts.worktreePath);
  if (dirty.trim().length > 0) {
    await writeValidationSummary(run.run_dir, opts.runId, results, dirty);
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'dirty_worktree_after_validation');
    await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'dirty_worktree_after_validation' });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony validation failed\n\nReason: dirty_worktree_after_validation\n');
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'Validation failed: dirty_worktree_after_validation' };
  }

  await writeValidationSummary(run.run_dir, opts.runId, results);
  await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'validation_completed');
  if (!opts.profile.github.create_pr) {
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony validation complete', '', `Issue: ${opts.issue.key}`, `Branch: ${opts.branch}`, `Worktree: ${opts.worktreePath}`, '', 'Manual inspection required before push, PR, CI, or Linear handoff.', ''].join('\n'));
    return { exitCode: EXIT_SUCCEEDED, run: await readRunById(opts.homeDir, opts.runId), message: `Validation complete for ${opts.issue.key}; manual inspection required` };
  }
  return runHandoffPhase({ homeDir: opts.homeDir, runId: opts.runId, profile: opts.profile, issue: opts.issue, branch: opts.branch, worktreePath: opts.worktreePath, git: opts.git, github: opts.github, linear: opts.linear });
}

async function runHandoffPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; branch: string; worktreePath: string; git: RealRunGitClient; github: RealRunGitHubClient; linear: RealRunLinearClient }): Promise<RunRealRunResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  try {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'handoff_running');
    const pr = await withScopedOperationLock(opts.homeDir, `branch:${opts.profile.repo.remote}:${opts.branch}`, async () => {
      await opts.git.pushBranch(opts.worktreePath, opts.profile.repo.remote, opts.branch);
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'git_branch_pushed', remote: opts.profile.repo.remote, branch: opts.branch } });

      const body = await buildPrBody({ runDir: run.run_dir, issue: opts.issue, branch: opts.branch, maxChars: opts.profile.github.pr_body_max_chars });
      const bodyPath = path.join(run.run_dir, 'pr-body.md');
      await writeFileAtomic(bodyPath, body);
      await addArtifacts(run.run_dir, [{ path: bodyPath, visibility: 'github_visible', kind: 'pr_body' }]);

      const prTitle = buildGithubVisiblePrTitle(opts.issue);
      return opts.github.createPullRequest({
        cwd: opts.worktreePath,
        title: prTitle,
        body,
        head: opts.branch,
        base: opts.profile.repo.base_branch,
        draft: opts.profile.github.draft,
      });
    });
    const prJsonPath = path.join(run.run_dir, 'pr.json');
    await writeJsonAtomic(prJsonPath, { schema_version: 1, run_id: opts.runId, number: pr.number, url: pr.url, head: opts.branch, base: opts.profile.repo.base_branch, draft: opts.profile.github.draft });
    await addArtifacts(run.run_dir, [{ path: prJsonPath, visibility: 'local_only', kind: 'pr_metadata' }]);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'github_pr_created', number: pr.number, url: pr.url } });
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'pr_created');
    const evidenceComment = await maybePostVerificationEvidenceComment({ runDir: run.run_dir, runId: opts.runId, profile: opts.profile, issue: opts.issue, pr, worktreePath: opts.worktreePath, github: opts.github });
    if (!evidenceComment.ok) {
      await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'verification_evidence_comment_failed');
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'verification_evidence_comment_failed', error: evidenceComment.error } });
      await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'verification_evidence_comment_failed' });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony verification evidence comment failed\n\nReason: verification_evidence_comment_failed\n');
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'Verification evidence comment failed: verification_evidence_comment_failed' };
    }
    if (!opts.profile.github.require_ci_green_before_success) {
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony PR created', '', `Issue: ${opts.issue.key}`, `Branch: ${opts.branch}`, `PR: ${pr.url}`, '', 'Stopped before CI wait or Linear success handoff.', ''].join('\n'));
      return { exitCode: EXIT_SUCCEEDED, run: await readRunById(opts.homeDir, opts.runId), message: `PR created for ${opts.issue.key}: ${pr.url}` };
    }
    return runCiPhase({ homeDir: opts.homeDir, runId: opts.runId, profile: opts.profile, issue: opts.issue, branch: opts.branch, worktreePath: opts.worktreePath, github: opts.github, linear: opts.linear, pr });
  } catch (error) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'pr_creation_failed');
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'pr_creation_failed', error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
    await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'pr_creation_failed' });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony PR creation failed\n\nReason: pr_creation_failed\n');
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'PR creation failed: pr_creation_failed' };
  }
}

async function runCiPhase(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; branch: string; worktreePath: string; github: RealRunGitHubClient; linear: RealRunLinearClient; pr: PullRequestResult; alreadyCiRunning?: boolean }): Promise<RunRealRunResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  try {
    if (!opts.alreadyCiRunning) await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'ci_running');
    const checks = await opts.github.waitForChecks({
      cwd: opts.worktreePath,
      prUrl: opts.pr.url,
      requiredOnly: opts.profile.github.required_checks.mode === 'github_required_checks',
      explicitCheckNames: opts.profile.github.required_checks.mode === 'explicit' ? opts.profile.github.required_checks.fallback : [],
      timeoutMs: opts.profile.github.ci_timeout_minutes * 60_000,
      intervalSeconds: opts.profile.github.ci_poll_interval_seconds,
    });
    await writeCiSummary(run.run_dir, opts.runId, checks.checks);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'github_ci_checked', pr_url: opts.pr.url, ok: checks.ok, check_count: checks.checks.length } });
    if (checks.ok) {
      await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'ci_completed');
      return runLinearSuccessHandoff({ homeDir: opts.homeDir, runId: opts.runId, profile: opts.profile, issue: opts.issue, branch: opts.branch, linear: opts.linear, pr: opts.pr });
    }
    const failedChecks = checks as { ok: false; reason: 'ci_failed' | 'ci_timeout'; checks: GitHubCheckRun[] };
    if (failedChecks.reason === 'ci_timeout') {
      await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'timed_out', 'ci_timeout');
      await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'ci_timeout' });
      await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony CI timed out', '', 'Reason: ci_timeout', `PR: ${opts.pr.url}`, ''].join('\n'));
      return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'CI timed out: ci_timeout' };
    }
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'ci_failed');
    await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'ci_failed' });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony CI failed', '', 'Reason: ci_failed', `PR: ${opts.pr.url}`, ''].join('\n'));
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'CI failed: ci_failed' };
  } catch (error) {
    const current = await readRunById(opts.homeDir, opts.runId);
    if (current.status === 'pr_created' || current.status === 'ci_running') await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'ci_failed');
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'ci_wait_failed', error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
    await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'ci_failed' });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony CI wait failed\n\nReason: ci_failed\n');
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'CI wait failed: ci_failed' };
  }
}

async function runLinearSuccessHandoff(opts: { homeDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; branch: string; linear: RealRunLinearClient; pr: PullRequestResult }): Promise<RunRealRunResult> {
  const run = await readRunById(opts.homeDir, opts.runId);
  try {
    const body = renderLinearSuccessComment({ issue: opts.issue, runId: opts.runId, runDir: run.run_dir, statusName: opts.profile.linear.success_status, prUrl: opts.pr.url });
    const artifactPath = path.join(run.run_dir, 'linear-success.md');
    await writeFileAtomic(artifactPath, body);
    await addArtifacts(run.run_dir, [{ path: artifactPath, visibility: 'linear_visible', kind: 'linear_success' }]);
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifact: 'linear-success.md', visibility: 'linear_visible', kind: 'linear_success' } });

    if (linearSuccessHandoffAlreadyComplete({ issue: opts.issue, runId: opts.runId, prUrl: opts.pr.url, successStatus: opts.profile.linear.success_status })) {
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'linear_success_handoff_already_complete', issue_id: opts.issue.id, issue_key: opts.issue.key, status: opts.issue.status } });
    } else {
      await opts.linear.updateIssueStatus({ issueId: opts.issue.id, profile: opts.profile, statusName: opts.profile.linear.success_status });
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'linear_success_status_set', issue_id: opts.issue.id, issue_key: opts.issue.key, status: opts.profile.linear.success_status } });
      await opts.linear.postComment(opts.issue.id, body);
      await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'linear_success_comment_posted', issue_id: opts.issue.id, issue_key: opts.issue.key } });
    }

    await writeFileAtomic(path.join(run.run_dir, 'result.md'), ['# Symphony Linear handoff complete', '', `Issue: ${opts.issue.key}`, `Branch: ${opts.branch}`, `PR: ${opts.pr.url}`, `Linear status: ${opts.profile.linear.success_status}`, ''].join('\n'));
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'succeeded');
    return { exitCode: EXIT_SUCCEEDED, run: await readRunById(opts.homeDir, opts.runId), message: `Linear handoff complete for ${opts.issue.key}: ${opts.pr.url}` };
  } catch (error) {
    await transitionRun({ homeDir: opts.homeDir }, opts.runId, 'failed', 'linear_handoff_failed');
    await appendEvent(run.run_dir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'linear_success_handoff_failed', issue_id: opts.issue.id, issue_key: opts.issue.key, error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
    await postFailureComment({ runDir: run.run_dir, runId: opts.runId, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'linear_handoff_failed' });
    await writeFileAtomic(path.join(run.run_dir, 'result.md'), '# Symphony Linear handoff failed\n\nReason: linear_handoff_failed\n');
    return { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.homeDir, opts.runId), message: 'Linear handoff failed: linear_handoff_failed' };
  }
}

function renderLinearSuccessComment(opts: { issue: LinearIssue; runId: string; runDir: string; statusName: string; prUrl: string }): string {
  return ['Symphony run succeeded.', '', `Issue: ${opts.issue.key}`, `Run ID: ${opts.runId}`, `Run record: ${opts.runDir}`, `PR: ${opts.prUrl}`, `Linear status: ${opts.statusName}`, '', 'Validation and required GitHub checks passed.'].join('\n');
}

function linearSuccessHandoffAlreadyComplete(opts: { issue: LinearIssue; runId: string; prUrl: string; successStatus: string }): boolean {
  if (opts.issue.status !== opts.successStatus) return false;
  return opts.issue.comments.some((comment) => comment.includes('Symphony run succeeded.') && comment.includes(`Run ID: ${opts.runId}`) && comment.includes(opts.prUrl));
}

async function writeCiSummary(runDir: string, runId: string, checks: GitHubCheckRun[]): Promise<void> {
  const jsonPath = path.join(runDir, 'ci-summary.json');
  const mdPath = path.join(runDir, 'ci-summary.md');
  await writeJsonAtomic(jsonPath, { schema_version: 1, run_id: runId, checks });
  const lines = ['# CI Summary', ''];
  if (checks.length === 0) lines.push('- No check data returned');
  for (const check of checks) {
    const suffix = check.link ? ` (${check.link})` : '';
    lines.push(`- ${check.name}: ${check.bucket} / ${check.state}${suffix}`);
  }
  await writeFileAtomic(mdPath, `${lines.join('\n')}\n`);
  await addArtifacts(runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'ci_summary_json' },
    { path: mdPath, visibility: 'redacted_shareable', kind: 'ci_summary_markdown' },
  ]);
  await appendEvent(runDir, { schema_version: 1, event_id: randomUUID(), run_id: runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['ci-summary.json', 'ci-summary.md'] } });
}

function buildGithubVisiblePrTitle(issue: LinearIssue): string {
  const raw = `${issue.key} ${issue.title}`;
  const title = redactShareableText(raw).replace(/\s+/g, ' ').trim() || issue.key;
  const scan = scanPublicContent(title, { surface: 'github' });
  if (!scan.ok) {
    const findings = scan.findings.map((finding) => finding.code).join(', ');
    throw new Error(`PR title failed safety scan: ${findings}`);
  }
  return title;
}

async function buildPrBody(opts: { runDir: string; issue: LinearIssue; branch: string; maxChars: number }): Promise<string> {
  const diffSummary = await readOptionalFile(path.join(opts.runDir, 'diff-summary.md'));
  const validationSummary = await readOptionalFile(path.join(opts.runDir, 'validation-summary.md'));
  const reviewSummary = await readOptionalFile(path.join(opts.runDir, 'agent-review.md'));
  const verificationSummary = await readOptionalFile(path.join(opts.runDir, 'verification-summary.md'));
  const raw = [
    `## Summary`,
    `- Symphony implementation for ${opts.issue.key}: ${opts.issue.title}`,
    `- Branch: ${opts.branch}`,
    '',
    '## Agent Review',
    reviewSummary.trim() || '- No agent review summary available',
    '',
    '## Smoke Verification',
    verificationSummary.trim() || '- No smoke verification summary available',
    '',
    '## Validation',
    validationSummary.trim() || '- No validation summary available',
    '',
    '## Change Summary',
    diffSummary.trim() || '- No diff summary available',
    '',
    `Linear: ${opts.issue.url}`,
    '',
    '_Created by Symphony supervised run._',
    '',
  ].join('\n');
  const body = enforcePrBodyMaxChars(redactShareableText(raw), opts.maxChars);
  const scan = scanPublicContent(body, { surface: 'github' });
  const blockingFindings = scan.findings.filter((finding) => finding.code !== 'secret_keyword');
  if (blockingFindings.length > 0) {
    const findings = blockingFindings.map((finding) => finding.code).join(', ');
    throw new Error(`PR body failed safety scan: ${findings}`);
  }
  return body;
}

function enforcePrBodyMaxChars(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const marker = '\n\n_ PR body truncated by Symphony because it exceeded configured `github.pr_body_max_chars`._\n';
  if (maxChars <= marker.length) return body.slice(0, Math.max(0, maxChars));
  return `${body.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function buildValidationCommand(command: ValidationCommand, cwd: string, rawLogPath: string, redactedLogPath: string): RunCommandOptions {
  const base = { cwd, timeoutMs: command.timeout_seconds * 1000, rawLogPath, redactedLogPath };
  if ('argv' in command) {
    const [executable, ...args] = command.argv;
    if (!executable) throw new Error(`validation command ${command.name} has empty argv`);
    return { ...base, mode: 'argv', command: executable, args };
  }
  return { ...base, mode: 'shell', command: command.shell };
}

async function writeVerificationSummary(runDir: string, runId: string, mode: string, results: Array<{ name: string; status: 'passed' | 'failed'; exitCode: number; timedOut: boolean; durationMs: number; mode: string }>, dirtyStatus?: string): Promise<void> {
  const jsonPath = path.join(runDir, 'verification-summary.json');
  const mdPath = path.join(runDir, 'verification-summary.md');
  await writeJsonAtomic(jsonPath, { schema_version: 1, run_id: runId, mode, results, dirty_status: dirtyStatus ?? null });
  const lines = ['# Smoke Verification Summary', '', `Mode: ${mode}`, ''];
  if (results.length === 0) lines.push('- No smoke verification commands configured');
  for (const result of results) lines.push(`- ${result.name}: ${result.status} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}, ${result.durationMs}ms)`);
  if (dirtyStatus) lines.push('', '## Dirty worktree after smoke verification', '', '```', dirtyStatus.trim(), '```');
  await writeFileAtomic(mdPath, `${lines.join('\n')}\n`);
  await addArtifacts(runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'verification_summary_json' },
    { path: mdPath, visibility: 'redacted_shareable', kind: 'verification_summary_markdown' },
  ]);
  await appendEvent(runDir, { schema_version: 1, event_id: randomUUID(), run_id: runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['verification-summary.json', 'verification-summary.md'] } });
}

type EvidenceLink = { title: string; url: string; media_type?: string; description?: string };

async function collectVerificationEvidence(opts: { runDir: string; runId: string; worktreePath: string; profile: SupervisedProfile }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const config = opts.profile.verification.evidence;
  if (!config.required && config.artifact_patterns.length === 0 && !config.hosted_url_file) return { ok: true };

  const matched = await findEvidenceFiles(opts.worktreePath, config.artifact_patterns);
  const evidenceDir = path.join(opts.runDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const copied: string[] = [];
  for (const source of matched) {
    const relativeSource = path.relative(opts.worktreePath, source);
    if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource)) return { ok: false, reason: `Verification evidence path escapes worktree: ${source}` };
    const dest = path.join(evidenceDir, relativeSource);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    copied.push(dest);
    if (isGeneratedEvidencePath(relativeSource)) await rm(source, { force: true });
  }

  let hostedUrlPath: string | null = null;
  if (config.hosted_url_file) {
    const safePath = safeWorktreePath(opts.worktreePath, config.hosted_url_file);
    if (!safePath.ok) return { ok: false, reason: safePath.reason };
    hostedUrlPath = safePath.path;
  }
  const rawLinks = hostedUrlPath ? await readEvidenceLinks(hostedUrlPath) : [];
  const links = normalizeEvidenceLinks(rawLinks);
  if (hostedUrlPath) await rm(hostedUrlPath, { force: true });
  if (config.required && copied.length === 0 && links.length === 0) return { ok: false, reason: 'Required verification evidence was not produced' };
  if (config.require_hosted_urls && links.length === 0) return { ok: false, reason: 'Required hosted verification evidence URLs were not produced' };

  const jsonPath = path.join(opts.runDir, 'evidence-summary.json');
  const mdPath = path.join(opts.runDir, 'evidence-summary.md');
  await writeJsonAtomic(jsonPath, { schema_version: 1, run_id: opts.runId, local_artifacts: copied.map((file) => path.relative(opts.runDir, file)), hosted_artifacts: links });
  await writeFileAtomic(mdPath, renderEvidenceSummary({ runId: opts.runId, localArtifacts: copied.map((file) => path.relative(opts.runDir, file)), hostedLinks: links }));
  await addArtifacts(opts.runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'verification_evidence_json' },
    { path: mdPath, visibility: 'github_visible', kind: 'verification_evidence_summary' },
    ...copied.map((file): RunArtifact => ({ path: file, visibility: 'redacted_shareable', kind: 'verification_video' })),
  ]);
  await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['evidence-summary.json', 'evidence-summary.md'], evidence_count: copied.length + links.length } });
  return { ok: true };
}

async function maybePostVerificationEvidenceComment(opts: { runDir: string; runId: string; profile: SupervisedProfile; issue: LinearIssue; pr: PullRequestResult; worktreePath: string; github: RealRunGitHubClient }): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!opts.profile.verification.evidence.github_pr_comment) return { ok: true };
  try {
    const summary = await readOptionalFile(path.join(opts.runDir, 'evidence-summary.md'));
    if (!summary.trim()) return { ok: true };
    const body = redactShareableText(['## Symphony Verification Evidence', '', `Issue: ${opts.issue.key}`, `Run ID: ${opts.runId}`, '', summary.trim(), '', '_Posted by Symphony after required evidence capture._', ''].join('\n'));
    const scan = scanPublicContent(body, { surface: 'github' });
    const blockingFindings = scan.findings.filter((finding) => finding.code !== 'secret_keyword');
    if (blockingFindings.length > 0) return { ok: false, error: `Verification evidence comment failed safety scan: ${blockingFindings.map((finding) => finding.code).join(', ')}` };
    await opts.github.postPullRequestComment({ cwd: opts.worktreePath, prUrl: opts.pr.url, body });
    await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'github_verification_evidence_comment_posted', pr_url: opts.pr.url } });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redactShareableText(error instanceof Error ? error.message : String(error)) };
  }
}

function renderEvidenceSummary(opts: { runId: string; localArtifacts: string[]; hostedLinks: EvidenceLink[] }): string {
  const lines = ['# Verification Evidence', '', `Run ID: ${opts.runId}`, ''];
  if (opts.hostedLinks.length > 0) {
    lines.push('## Video / hosted artifacts', '');
    for (const artifact of opts.hostedLinks) {
      const safeUrl = safeEvidenceUrl(artifact.url);
      if (!safeUrl) continue;
      const title = markdownLinkText(artifact.title || 'Verification artifact');
      const description = artifact.description ? ` — ${markdownLinkText(artifact.description)}` : '';
      lines.push(`- [${title}](${safeUrl})${description}`);
    }
  }
  if (opts.localArtifacts.length > 0) {
    lines.push('', '## Local run artifacts', '');
    for (const artifact of opts.localArtifacts) lines.push(`- ${artifact}`);
  }
  if (opts.hostedLinks.length === 0 && opts.localArtifacts.length === 0) lines.push('- No verification evidence artifacts collected');
  return `${lines.join('\n')}\n`;
}

async function readEvidenceLinks(filePath: string): Promise<EvidenceLink[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { artifacts?: unknown } | unknown[];
    const rawItems = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { artifacts?: unknown }).artifacts) ? (parsed as { artifacts: unknown[] }).artifacts : [];
    return rawItems.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.url !== 'string') return [];
      return [{ title: typeof record.title === 'string' ? record.title : 'Verification artifact', url: record.url, ...(typeof record.media_type === 'string' ? { media_type: record.media_type } : {}), ...(typeof record.description === 'string' ? { description: record.description } : {}) }];
    });
  } catch {
    return [];
  }
}

async function findEvidenceFiles(root: string, patterns: string[]): Promise<string[]> {
  const matched = new Set<string>();
  for (const pattern of patterns) {
    const matcher = evidencePatternMatcher(root, pattern);
    if (!matcher.ok) continue;
    const files = await walkFiles(matcher.baseDir);
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      if (relative.startsWith(matcher.relativePrefix) && file.endsWith(matcher.suffix)) matched.add(file);
    }
  }
  return [...matched].sort();
}

function evidencePatternMatcher(root: string, pattern: string): { ok: true; baseDir: string; relativePrefix: string; suffix: string } | { ok: false } {
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]+/u).includes('..')) return { ok: false };
  const normalized = pattern.split(path.sep).join('/');
  const firstStar = normalized.indexOf('*');
  if (firstStar < 0) {
    const safe = safeWorktreePath(root, normalized);
    if (!safe.ok) return { ok: false };
    return { ok: true, baseDir: path.dirname(safe.path), relativePrefix: normalized, suffix: '' };
  }
  const prefixBeforeGlob = normalized.slice(0, firstStar);
  const relativeBase = prefixBeforeGlob.includes('/') ? prefixBeforeGlob.slice(0, prefixBeforeGlob.lastIndexOf('/')) : '.';
  const suffix = normalized.slice(normalized.lastIndexOf('*') + 1);
  const safe = safeWorktreePath(root, relativeBase || '.');
  if (!safe.ok) return { ok: false };
  const relativePrefix = relativeBase === '.' ? '' : `${relativeBase.replace(/\/$/u, '')}/`;
  return { ok: true, baseDir: safe.path, relativePrefix, suffix };
}

function safeWorktreePath(root: string, relativePath: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes('..')) return { ok: false, reason: `Verification evidence path must stay inside the worktree: ${relativePath}` };
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: `Verification evidence path must stay inside the worktree: ${relativePath}` };
  return { ok: true, path: resolved };
}

function isGeneratedEvidencePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized.startsWith('.symphony/evidence/') || normalized.includes('/test-results/') || normalized.startsWith('test-results/');
}

function markdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/gu, '\\$&').replace(/\r?\n/gu, ' ');
}

function safeEvidenceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeEvidenceLinks(links: EvidenceLink[]): EvidenceLink[] {
  return links.flatMap((link) => {
    const safeUrl = safeEvidenceUrl(link.url);
    if (!safeUrl) return [];
    return [{ ...link, url: safeUrl }];
  });
}

async function walkFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function writeValidationSummary(runDir: string, runId: string, results: Array<{ name: string; status: 'passed' | 'failed'; exitCode: number; timedOut: boolean; durationMs: number }>, dirtyStatus?: string): Promise<void> {
  const jsonPath = path.join(runDir, 'validation-summary.json');
  const mdPath = path.join(runDir, 'validation-summary.md');
  const summary = { schema_version: 1, run_id: runId, results, dirty_status: dirtyStatus ?? null };
  await writeJsonAtomic(jsonPath, summary);
  const lines = ['# Validation Summary', ''];
  if (results.length === 0) lines.push('- No validation commands configured');
  for (const result of results) lines.push(`- ${result.name}: ${result.status} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}, ${result.durationMs}ms)`);
  if (dirtyStatus) lines.push('', '## Dirty worktree after validation', '', '```', dirtyStatus.trim(), '```');
  await writeFileAtomic(mdPath, `${lines.join('\n')}\n`);
  await addArtifacts(runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'validation_summary_json' },
    { path: mdPath, visibility: 'redacted_shareable', kind: 'validation_summary_markdown' },
  ]);
  await appendEvent(runDir, { schema_version: 1, event_id: randomUUID(), run_id: runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifacts: ['validation-summary.json', 'validation-summary.md'] } });
}

async function getRemoteBaseShaOrFail(opts: { opts: RunRealRunOptions; run: RunRecord; profile: SupervisedProfile; issue: LinearIssue; git: RealRunGitClient; linear: RealRunLinearClient }): Promise<{ ok: true; baseSha: string } | { ok: false; result: RunRealRunResult }> {
  try {
    return { ok: true, baseSha: await opts.git.remoteBaseSha(opts.profile.repo.path, opts.profile.repo.remote, opts.profile.repo.base_branch) };
  } catch {
    await transitionRun({ homeDir: opts.opts.homeDir }, opts.run.run_id, 'failed', 'final_fetch_failed');
    await postFailureComment({ runDir: opts.run.run_dir, runId: opts.run.run_id, issue: opts.issue, linear: opts.linear, profile: opts.profile, reason: 'final_fetch_failed' });
    await writeFileAtomic(path.join(opts.run.run_dir, 'result.md'), '# Symphony post-claim step failed\n\nReason: final_fetch_failed\n');
    return { ok: false, result: { exitCode: EXIT_CODEX_FAILED, run: await readRunById(opts.opts.homeDir, opts.run.run_id), message: 'Post-claim step failed: final_fetch_failed' } };
  }
}

async function postFailureComment(opts: { runDir: string; runId: string; issue: LinearIssue; linear: ClaimLinearClient; profile?: SupervisedProfile; reason: RunReason }): Promise<void> {
  const body = ['Symphony run failed after claim.', '', `Issue: ${opts.issue.key}`, `Run ID: ${opts.runId}`, `Run record: ${opts.runDir}`, `Reason: ${opts.reason}`, '', 'The issue is intentionally left assigned/in-progress for manual recovery unless a failure status is configured.'].join('\n');
  const artifactPath = path.join(opts.runDir, 'linear-failure.md');
  await writeFileAtomic(artifactPath, body);
  await addArtifacts(opts.runDir, [{ path: artifactPath, visibility: 'linear_visible', kind: 'linear_failure' }]);
  await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'artifact', data: { artifact: 'linear-failure.md', visibility: 'linear_visible', kind: 'linear_failure' } });
  if (opts.profile?.linear.failure_status && opts.linear.updateIssueStatus) {
    try {
      await opts.linear.updateIssueStatus({ issueId: opts.issue.id, profile: opts.profile, statusName: opts.profile.linear.failure_status });
      await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'linear_failure_status_set', issue_id: opts.issue.id, issue_key: opts.issue.key, status: opts.profile.linear.failure_status, reason: opts.reason } });
    } catch (error) {
      await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'linear_failure_status_failed', issue_id: opts.issue.id, issue_key: opts.issue.key, reason: opts.reason, error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
    }
  }
  try {
    await opts.linear.postComment(opts.issue.id, body);
    await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'side_effect', data: { side_effect: 'linear_failure_comment_posted', issue_id: opts.issue.id, issue_key: opts.issue.key, reason: opts.reason } });
  } catch (error) {
    await appendEvent(opts.runDir, { schema_version: 1, event_id: randomUUID(), run_id: opts.runId, timestamp: new Date().toISOString(), type: 'warning', data: { warning: 'linear_failure_comment_failed', issue_id: opts.issue.id, issue_key: opts.issue.key, reason: opts.reason, error: redactShareableText(error instanceof Error ? error.message : String(error)) } });
  }
}

function buildClients(overrides: Partial<RealRunClients> = {}): RealRunClients {
  const git = overrides.git ?? new GitAdapter();
  const linear = overrides.linear ?? new LinearReadAdapter();
  const codex = overrides.codex ?? new CodexAdapter();
  return {
    git,
    linear,
    github: overrides.github ?? new GitHubCliAdapter(),
    codexReadiness: overrides.codexReadiness ?? codex as unknown as CodexPreflightClient,
    codex,
    reviewer: overrides.reviewer ?? codex,
    validation: overrides.validation ?? { run: runCommand },
  };
}

async function getByIssueKey(linear: RealRunLinearClient, profile: SupervisedProfile, issueKey: string): Promise<LinearIssue[]> {
  if (linear.getIssueByKey) {
    const issue = await linear.getIssueByKey(issueKey, profile);
    return issue ? [issue] : [];
  }
  return (await linear.findEligibleIssues(profile)).filter((issue) => issue.key === issueKey);
}

async function writePreflightArtifacts(runDir: string, runId: string, preflight: PreflightResult): Promise<void> {
  const jsonPath = path.join(runDir, 'preflight.json');
  const mdPath = path.join(runDir, 'preflight.md');
  await writeJsonAtomic(jsonPath, { schema_version: 1, run_id: runId, ...preflight });
  await writeFileAtomic(mdPath, renderPreflightMarkdown(preflight));
  await addArtifacts(runDir, [
    { path: jsonPath, visibility: 'local_only', kind: 'preflight_json' },
    { path: mdPath, visibility: 'redacted_shareable', kind: 'preflight_markdown' },
  ]);
}

function renderPreflightMarkdown(preflight: PreflightResult): string {
  const lines = ['# Preflight', '', `Status: ${preflight.ok ? 'passed' : 'failed'}`, '', '## Checks'];
  for (const check of preflight.checks) lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.code ? ` (${check.code})` : ''}${check.detail ? `: ${check.detail}` : ''}`);
  return `${lines.join('\n')}\n`;
}

async function addArtifacts(runDir: string, newArtifacts: RunArtifact[]): Promise<void> {
  const artifactsPath = path.join(runDir, 'artifacts.json');
  const manifest = JSON.parse(await readFile(artifactsPath, 'utf8')) as ArtifactsManifest;
  const byPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const artifact of newArtifacts) byPath.set(artifact.path, artifact);
  await writeJsonAtomic(artifactsPath, { ...manifest, artifacts: Array.from(byPath.values()) });
}

function branchName(profileName: string, issueKey: string, title: string): string {
  return `symphony/${safeSegment(profileName)}/${issueKey}-${slug(title)}`;
}

function issueLockScopeFor(profileName: string, issueKey: string): string {
  return `issue:${safeSegment(profileName)}:${issueKey}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'implementation';
}
