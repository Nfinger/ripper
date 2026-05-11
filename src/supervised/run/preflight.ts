import path from 'node:path';
import type { LinearAssigneeConfig, SupervisedProfile } from '../profile/types.js';

export type PreflightFailureCode =
  | 'repo_path_not_absolute'
  | 'repo_not_worktree'
  | 'repo_is_bare'
  | 'dirty_main_checkout'
  | 'main_checkout_not_on_base_branch'
  | 'merge_or_rebase_in_progress'
  | 'base_fetch_failed'
  | 'target_branch_exists_local'
  | 'target_branch_exists_remote'
  | 'github_auth_unreadable'
  | 'linear_auth_unreadable'
  | 'linear_status_unreadable'
  | 'linear_assignee_unreadable'
  | 'codex_unavailable'
  | 'codex_noninteractive_unavailable'
  | 'codex_version_too_old';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
  code?: PreflightFailureCode;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  failures: PreflightFailureCode[];
}

export interface ReadinessResult {
  ok: boolean;
  reason?: string;
}

export interface CodexReadinessResult extends ReadinessResult {
  version?: string;
  code?: 'codex_unavailable' | 'codex_noninteractive_unavailable' | 'codex_version_too_old';
}

export interface GitPreflightClient {
  isWorktree(repoPath: string): Promise<boolean>;
  isBareRepo(repoPath: string): Promise<boolean>;
  statusPorcelain(repoPath: string): Promise<string>;
  currentBranch(repoPath: string): Promise<string>;
  fetchBase(repoPath: string, remote: string, base: string): Promise<void>;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  remoteBranchExists(repoPath: string, remote: string, branch: string): Promise<boolean>;
  hasMergeOrRebaseInProgress(repoPath: string): Promise<boolean>;
}

export interface GitHubPreflightClient {
  checkAuth(): Promise<ReadinessResult>;
}

export interface LinearPreflightClient {
  checkAuth(profile: SupervisedProfile): Promise<ReadinessResult>;
  checkStatus(statusName: string, profile: SupervisedProfile): Promise<ReadinessResult>;
  checkAssignee(assignee: LinearAssigneeConfig, profile: SupervisedProfile): Promise<ReadinessResult>;
}

export interface CodexPreflightClient {
  checkAvailable(command: string, minVersion?: string): Promise<CodexReadinessResult>;
}

export interface RunPreflightOptions {
  profile: SupervisedProfile;
  targetBranch: string;
  git: GitPreflightClient;
  github: GitHubPreflightClient;
  linear: LinearPreflightClient;
  codex: CodexPreflightClient;
}

export async function runPreflight(opts: RunPreflightOptions): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const profile = opts.profile;
  const repoPath = path.resolve(profile.repo.path);

  if (!path.isAbsolute(profile.repo.path)) {
    checks.push(fail('repo_path_absolute', 'repo_path_not_absolute', 'repo.path must be absolute'));
    const failures = checks.filter((check) => !check.ok && check.code).map((check) => check.code as PreflightFailureCode);
    return { ok: false, checks, failures };
  }

  await recordBoolean(checks, 'repo_is_worktree', 'repo_not_worktree', () => opts.git.isWorktree(repoPath));
  await recordNegativeBoolean(checks, 'repo_not_bare', 'repo_is_bare', () => opts.git.isBareRepo(repoPath));

  if (profile.preflight.require_main_checkout_clean) {
    await recordStringPredicate(checks, 'main_checkout_clean', 'dirty_main_checkout', () => opts.git.statusPorcelain(repoPath), (value) => value.trim().length === 0);
  }

  if (profile.preflight.require_main_checkout_on_base_branch) {
    await recordStringPredicate(checks, 'main_checkout_on_base_branch', 'main_checkout_not_on_base_branch', () => opts.git.currentBranch(repoPath), (value) => value.trim() === profile.repo.base_branch);
  }

  if (profile.preflight.require_no_merge_or_rebase_in_progress) {
    await recordNegativeBoolean(checks, 'no_merge_or_rebase_in_progress', 'merge_or_rebase_in_progress', () => opts.git.hasMergeOrRebaseInProgress(repoPath));
  }

  if (profile.preflight.require_base_fetchable) {
    try {
      await opts.git.fetchBase(repoPath, profile.repo.remote, profile.repo.base_branch);
      checks.push(pass('base_fetchable'));
    } catch (error) {
      checks.push(fail('base_fetchable', 'base_fetch_failed', errorDetail(error)));
    }
  }

  if (profile.preflight.require_target_branch_absent) {
    await recordNegativeBoolean(checks, 'target_branch_absent_local', 'target_branch_exists_local', () => opts.git.branchExists(repoPath, opts.targetBranch));
    await recordNegativeBoolean(checks, 'target_branch_absent_remote', 'target_branch_exists_remote', () => opts.git.remoteBranchExists(repoPath, profile.repo.remote, opts.targetBranch));
  }

  if (profile.preflight.require_github_auth) {
    const result = await opts.github.checkAuth();
    checks.push(result.ok ? pass('github_auth_readable') : fail('github_auth_readable', 'github_auth_unreadable', result.reason));
  }

  if (profile.preflight.require_linear_auth) {
    const auth = await opts.linear.checkAuth(profile);
    checks.push(auth.ok ? pass('linear_auth_readable') : fail('linear_auth_readable', 'linear_auth_unreadable', auth.reason));
    const claim = await opts.linear.checkStatus(profile.linear.claim_status, profile);
    checks.push(claim.ok ? pass('linear_claim_status_readable') : fail('linear_claim_status_readable', 'linear_status_unreadable', claim.reason));
    const success = await opts.linear.checkStatus(profile.linear.success_status, profile);
    checks.push(success.ok ? pass('linear_success_status_readable') : fail('linear_success_status_readable', 'linear_status_unreadable', success.reason));
    const assignee = await opts.linear.checkAssignee(profile.linear.assignee, profile);
    checks.push(assignee.ok ? pass('linear_assignee_readable') : fail('linear_assignee_readable', 'linear_assignee_unreadable', assignee.reason));
  }

  if (profile.preflight.require_codex_available) {
    const result = await opts.codex.checkAvailable(profile.agent.command, profile.agent.min_version);
    const code = result.code ?? 'codex_unavailable';
    checks.push(result.ok ? pass('codex_available', result.version) : fail('codex_available', code, result.reason));
  }

  const failures = checks.filter((check) => !check.ok && check.code).map((check) => check.code as PreflightFailureCode);
  return { ok: failures.length === 0, checks, failures };
}

async function recordBoolean(checks: PreflightCheck[], name: string, code: PreflightFailureCode, fn: () => Promise<boolean>): Promise<void> {
  try {
    const ok = await fn();
    checks.push(ok ? pass(name) : fail(name, code));
  } catch (error) {
    checks.push(fail(name, code, errorDetail(error)));
  }
}

async function recordNegativeBoolean(checks: PreflightCheck[], name: string, code: PreflightFailureCode, fn: () => Promise<boolean>): Promise<void> {
  try {
    const exists = await fn();
    checks.push(exists ? fail(name, code) : pass(name));
  } catch (error) {
    checks.push(fail(name, code, errorDetail(error)));
  }
}

async function recordStringPredicate(checks: PreflightCheck[], name: string, code: PreflightFailureCode, fn: () => Promise<string>, predicate: (value: string) => boolean): Promise<void> {
  try {
    const value = await fn();
    checks.push(predicate(value) ? pass(name) : fail(name, code, value.trim()));
  } catch (error) {
    checks.push(fail(name, code, errorDetail(error)));
  }
}

function pass(name: string, detail?: string): PreflightCheck {
  return detail ? { name, ok: true, detail } : { name, ok: true };
}

function fail(name: string, code: PreflightFailureCode, detail?: string): PreflightCheck {
  return detail ? { name, ok: false, code, detail } : { name, ok: false, code };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
