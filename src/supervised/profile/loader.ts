import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { SupervisedProfileError } from './errors.js';
import type {
  AgentConfig,
  ChangePolicyConfig,
  CleanupConfig,
  GitHubConfig,
  KnowledgeConfig,
  LinearConfig,
  PreflightConfig,
  PromptConfig,
  RepoConfig,
  RunConfig,
  SupervisedProfile,
  ValidationCommand,
  ValidationConfig,
  AgentReviewConfig,
  VerificationConfig,
  GitConfig,
} from './types.js';
import { SUPERVISED_PROFILE_SCHEMA_VERSION } from './types.js';

export type ProfileLoadResult =
  | { ok: true; profile: SupervisedProfile; sourcePath: string; resolvedHash: string }
  | { ok: false; error: SupervisedProfileError };

type ParseResult<T> = T | SupervisedProfileError;

const TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'name',
  'repo',
  'linear',
  'agent',
  'prompt',
  'knowledge',
  'preflight',
  'agent_review',
  'verification',
  'validation',
  'change_policy',
  'git',
  'github',
  'run',
  'cleanup',
]);

export function profilePath(profileName: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.symphony', 'profiles', `${profileName}.yaml`);
}

export function isSafeProfileName(profileName: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(profileName);
}

export function loadSupervisedProfile(profileName: string, opts: { homeDir?: string } = {}): ProfileLoadResult {
  if (!isSafeProfileName(profileName)) {
    return fail('profile_name_invalid', 'Profile name may only contain letters, numbers, dots, underscores, and hyphens');
  }
  const sourcePath = profilePath(profileName, opts.homeDir ?? os.homedir());
  if (!existsSync(sourcePath)) {
    return fail('profile_not_found', `Profile not found: ${sourcePath}`, { path: sourcePath });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(sourcePath, 'utf8'));
  } catch (error) {
    return fail('profile_yaml_invalid', `Invalid profile YAML: ${error instanceof Error ? error.message : String(error)}`, {
      path: sourcePath,
    });
  }

  const profile = parseProfile(parsed, sourcePath);
  if (profile instanceof SupervisedProfileError) return { ok: false, error: profile };

  return {
    ok: true,
    profile,
    sourcePath,
    resolvedHash: sha256(stableStringify(profile)),
  };
}

function parseProfile(value: unknown, sourcePath: string): ParseResult<SupervisedProfile> {
  if (!isRecord(value)) return err('profile_root_invalid', 'Profile must be a YAML object', sourcePath);

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) return err('profile_unknown_key', `Unknown top-level profile key: ${key}`, sourcePath, key);
  }

  if (!('schema_version' in value)) return err('profile_schema_version_missing', 'Profile is missing schema_version', sourcePath, 'schema_version');
  if (value.schema_version !== SUPERVISED_PROFILE_SCHEMA_VERSION) {
    return err('profile_schema_version_unsupported', `Unsupported profile schema_version: ${String(value.schema_version)}`, sourcePath, 'schema_version');
  }

  const name = requiredString(value, 'name', sourcePath);
  if (name instanceof SupervisedProfileError) return name;
  const repoRecord = requiredRecord(value, 'repo', sourcePath);
  if (repoRecord instanceof SupervisedProfileError) return repoRecord;
  const linearRecord = requiredRecord(value, 'linear', sourcePath);
  if (linearRecord instanceof SupervisedProfileError) return linearRecord;
  const agentRecord = requiredRecord(value, 'agent', sourcePath);
  if (agentRecord instanceof SupervisedProfileError) return agentRecord;
  const promptRecord = requiredRecord(value, 'prompt', sourcePath);
  if (promptRecord instanceof SupervisedProfileError) return promptRecord;
  const knowledgeRecord = optionalRecord(value, 'knowledge', sourcePath);
  if (knowledgeRecord instanceof SupervisedProfileError) return knowledgeRecord;
  const preflightRecord = requiredRecord(value, 'preflight', sourcePath);
  if (preflightRecord instanceof SupervisedProfileError) return preflightRecord;
  const agentReviewRecord = optionalRecord(value, 'agent_review', sourcePath);
  if (agentReviewRecord instanceof SupervisedProfileError) return agentReviewRecord;
  const verificationRecord = optionalRecord(value, 'verification', sourcePath);
  if (verificationRecord instanceof SupervisedProfileError) return verificationRecord;
  const validationRecord = requiredRecord(value, 'validation', sourcePath);
  if (validationRecord instanceof SupervisedProfileError) return validationRecord;
  const changePolicyRecord = requiredRecord(value, 'change_policy', sourcePath);
  if (changePolicyRecord instanceof SupervisedProfileError) return changePolicyRecord;
  const gitRecord = requiredRecord(value, 'git', sourcePath);
  if (gitRecord instanceof SupervisedProfileError) return gitRecord;
  const githubRecord = requiredRecord(value, 'github', sourcePath);
  if (githubRecord instanceof SupervisedProfileError) return githubRecord;
  const runRecord = requiredRecord(value, 'run', sourcePath);
  if (runRecord instanceof SupervisedProfileError) return runRecord;
  const cleanupRecord = requiredRecord(value, 'cleanup', sourcePath);
  if (cleanupRecord instanceof SupervisedProfileError) return cleanupRecord;

  const repo = parseRepo(repoRecord, sourcePath);
  if (repo instanceof SupervisedProfileError) return repo;
  const linear = parseLinear(linearRecord, sourcePath);
  if (linear instanceof SupervisedProfileError) return linear;
  const agent = parseAgent(agentRecord, sourcePath);
  if (agent instanceof SupervisedProfileError) return agent;
  const prompt = parsePrompt(promptRecord, sourcePath);
  if (prompt instanceof SupervisedProfileError) return prompt;
  const knowledge = parseKnowledge(knowledgeRecord, sourcePath);
  if (knowledge instanceof SupervisedProfileError) return knowledge;
  const preflight = parsePreflight(preflightRecord, sourcePath);
  if (preflight instanceof SupervisedProfileError) return preflight;
  const agentReview = parseAgentReview(agentReviewRecord, sourcePath);
  if (agentReview instanceof SupervisedProfileError) return agentReview;
  const verification = parseVerification(verificationRecord, sourcePath);
  if (verification instanceof SupervisedProfileError) return verification;
  const validation = parseValidation(validationRecord, sourcePath);
  if (validation instanceof SupervisedProfileError) return validation;
  const changePolicy = parseChangePolicy(changePolicyRecord, sourcePath);
  if (changePolicy instanceof SupervisedProfileError) return changePolicy;
  const git = parseGit(gitRecord, sourcePath);
  if (git instanceof SupervisedProfileError) return git;
  const github = parseGitHub(githubRecord, sourcePath);
  if (github instanceof SupervisedProfileError) return github;
  const run = parseRun(runRecord, sourcePath);
  if (run instanceof SupervisedProfileError) return run;
  const cleanup = parseCleanup(cleanupRecord, sourcePath);
  if (cleanup instanceof SupervisedProfileError) return cleanup;

  return { schema_version: 1, name, repo, linear, agent, prompt, knowledge, preflight, agent_review: agentReview, verification, validation, change_policy: changePolicy, git, github, run, cleanup };
}

function parseRepo(record: Record<string, unknown>, sourcePath: string): ParseResult<RepoConfig> {
  const repoPath = requiredString(record, 'path', sourcePath, 'repo.path');
  if (repoPath instanceof SupervisedProfileError) return repoPath;
  if (!path.isAbsolute(repoPath)) return err('repo_path_not_absolute', 'repo.path must be absolute', sourcePath, 'repo.path');
  const canonicalRepoPath = path.resolve(repoPath);
  const remote = requiredString(record, 'remote', sourcePath, 'repo.remote');
  if (remote instanceof SupervisedProfileError) return remote;
  const baseBranch = requiredString(record, 'base_branch', sourcePath, 'repo.base_branch');
  if (baseBranch instanceof SupervisedProfileError) return baseBranch;
  return { path: canonicalRepoPath, remote, base_branch: baseBranch };
}

function parseLinear(record: Record<string, unknown>, sourcePath: string): ParseResult<LinearConfig> {
  const team = requiredString(record, 'team', sourcePath, 'linear.team');
  if (team instanceof SupervisedProfileError) return team;
  const projectValue = record.project;
  if (projectValue !== null && typeof projectValue !== 'string') return invalid(sourcePath, 'linear.project');
  const project = projectValue;
  const eligible = requiredString(record, 'eligible_status', sourcePath, 'linear.eligible_status');
  if (eligible instanceof SupervisedProfileError) return eligible;
  const claim = requiredString(record, 'claim_status', sourcePath, 'linear.claim_status');
  if (claim instanceof SupervisedProfileError) return claim;
  const success = requiredString(record, 'success_status', sourcePath, 'linear.success_status');
  if (success instanceof SupervisedProfileError) return success;
  const requireUnassigned = requiredBoolean(record, 'require_unassigned', sourcePath, 'linear.require_unassigned');
  if (requireUnassigned instanceof SupervisedProfileError) return requireUnassigned;
  const labels = requiredStringArray(record, 'required_labels', sourcePath, 'linear.required_labels');
  if (labels instanceof SupervisedProfileError) return labels;
  const failureStatus = record.failure_status;
  if (failureStatus !== null && typeof failureStatus !== 'string') return invalid(sourcePath, 'linear.failure_status');
  const includeComments = requiredBoolean(record, 'include_comments', sourcePath, 'linear.include_comments');
  if (includeComments instanceof SupervisedProfileError) return includeComments;
  const maxComments = requiredNumber(record, 'max_comments', sourcePath, 'linear.max_comments');
  if (maxComments instanceof SupervisedProfileError) return maxComments;
  if (record.comment_order !== 'chronological' && record.comment_order !== 'reverse_chronological') return invalid(sourcePath, 'linear.comment_order');
  const commentOrder = record.comment_order as LinearConfig['comment_order'];
  const includeAttachmentLinks = requiredBoolean(record, 'include_attachment_links', sourcePath, 'linear.include_attachment_links');
  if (includeAttachmentLinks instanceof SupervisedProfileError) return includeAttachmentLinks;
  const downloadAttachments = requiredBoolean(record, 'download_attachments', sourcePath, 'linear.download_attachments');
  if (downloadAttachments instanceof SupervisedProfileError) return downloadAttachments;
  const commentMaxChars = requiredNumber(record, 'comment_max_chars', sourcePath, 'linear.comment_max_chars');
  if (commentMaxChars instanceof SupervisedProfileError) return commentMaxChars;
  const outputTailMaxLines = requiredNumber(record, 'output_tail_max_lines', sourcePath, 'linear.output_tail_max_lines');
  if (outputTailMaxLines instanceof SupervisedProfileError) return outputTailMaxLines;
  const assigneeRecord = requiredRecord(record, 'assignee', sourcePath, 'linear.assignee');
  if (assigneeRecord instanceof SupervisedProfileError) return assigneeRecord;
  const common = { team, project, eligible_status: eligible, claim_status: claim, success_status: success, failure_status: failureStatus, require_unassigned: requireUnassigned, required_labels: labels, include_comments: includeComments, max_comments: maxComments, comment_order: commentOrder, include_attachment_links: includeAttachmentLinks, download_attachments: downloadAttachments, comment_max_chars: commentMaxChars, output_tail_max_lines: outputTailMaxLines };
  if (assigneeRecord.mode === 'authenticated_user') {
    return { ...common, assignee: { mode: 'authenticated_user' } };
  }
  if (assigneeRecord.mode === 'user_id') {
    const userId = requiredString(assigneeRecord, 'user_id', sourcePath, 'linear.assignee.user_id');
    if (userId instanceof SupervisedProfileError) return userId;
    return { ...common, assignee: { mode: 'user_id', user_id: userId } };
  }
  return invalid(sourcePath, 'linear.assignee.mode');
}

function parseAgent(record: Record<string, unknown>, sourcePath: string): ParseResult<AgentConfig> {
  if (record.kind !== 'codex') return err('agent_kind_unsupported', `Unsupported agent.kind: ${String(record.kind)}`, sourcePath, 'agent.kind');
  const command = requiredString(record, 'command', sourcePath, 'agent.command');
  if (command instanceof SupervisedProfileError) return command;
  const timeout = requiredNumber(record, 'timeout_minutes', sourcePath, 'agent.timeout_minutes');
  if (timeout instanceof SupervisedProfileError) return timeout;
  const modelValue = record.model;
  if (modelValue !== null && typeof modelValue !== 'string') return invalid(sourcePath, 'agent.model');
  const model = modelValue;
  const minVersion = record.min_version;
  if (minVersion !== undefined && typeof minVersion !== 'string') return invalid(sourcePath, 'agent.min_version');
  const allowNetwork = requiredBoolean(record, 'allow_network', sourcePath, 'agent.allow_network');
  if (allowNetwork instanceof SupervisedProfileError) return allowNetwork;
  const allowWebLookup = requiredBoolean(record, 'allow_web_lookup', sourcePath, 'agent.allow_web_lookup');
  if (allowWebLookup instanceof SupervisedProfileError) return allowWebLookup;
  if (record.allow_browser_automation !== false) return invalid(sourcePath, 'agent.allow_browser_automation');
  return minVersion === undefined
    ? { kind: 'codex', command, model, timeout_minutes: timeout, allow_network: allowNetwork, allow_web_lookup: allowWebLookup, allow_browser_automation: false }
    : { kind: 'codex', command, model, min_version: minVersion, timeout_minutes: timeout, allow_network: allowNetwork, allow_web_lookup: allowWebLookup, allow_browser_automation: false };
}

function parsePrompt(record: Record<string, unknown>, sourcePath: string): ParseResult<PromptConfig> {
  const files = requiredStringArray(record, 'include_repo_instruction_files', sourcePath, 'prompt.include_repo_instruction_files');
  if (files instanceof SupervisedProfileError) return files;
  const maxChars = requiredNumber(record, 'repo_instruction_max_chars', sourcePath, 'prompt.repo_instruction_max_chars');
  if (maxChars instanceof SupervisedProfileError) return maxChars;
  const extraValue = record.extra_instructions;
  if (extraValue !== null && typeof extraValue !== 'string') return invalid(sourcePath, 'prompt.extra_instructions');
  const extra = extraValue;
  return { include_repo_instruction_files: files, repo_instruction_max_chars: maxChars, extra_instructions: extra };
}

function parseKnowledge(record: Record<string, unknown> | null, sourcePath: string): ParseResult<KnowledgeConfig> {
  if (record === null) return { enabled: false, include: [], max_bytes: 80000 };
  const enabled = requiredBoolean(record, 'enabled', sourcePath, 'knowledge.enabled');
  if (enabled instanceof SupervisedProfileError) return enabled;
  const include = requiredStringArray(record, 'include', sourcePath, 'knowledge.include');
  if (include instanceof SupervisedProfileError) return include;
  for (const [index, item] of include.entries()) {
    if (path.isAbsolute(item) || item.split(/[\\/]+/u).includes('..')) return invalid(sourcePath, `knowledge.include.${index}`);
  }
  const maxBytes = requiredNumber(record, 'max_bytes', sourcePath, 'knowledge.max_bytes');
  if (maxBytes instanceof SupervisedProfileError) return maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) return invalid(sourcePath, 'knowledge.max_bytes');
  return { enabled, include, max_bytes: maxBytes };
}

function parsePreflight(record: Record<string, unknown>, sourcePath: string): ParseResult<PreflightConfig> {
  const require_main_checkout_clean = requiredBoolean(record, 'require_main_checkout_clean', sourcePath, 'preflight.require_main_checkout_clean');
  if (require_main_checkout_clean instanceof SupervisedProfileError) return require_main_checkout_clean;
  const require_main_checkout_on_base_branch = requiredBoolean(record, 'require_main_checkout_on_base_branch', sourcePath, 'preflight.require_main_checkout_on_base_branch');
  if (require_main_checkout_on_base_branch instanceof SupervisedProfileError) return require_main_checkout_on_base_branch;
  const require_no_merge_or_rebase_in_progress = requiredBoolean(record, 'require_no_merge_or_rebase_in_progress', sourcePath, 'preflight.require_no_merge_or_rebase_in_progress');
  if (require_no_merge_or_rebase_in_progress instanceof SupervisedProfileError) return require_no_merge_or_rebase_in_progress;
  const require_base_fetchable = requiredBoolean(record, 'require_base_fetchable', sourcePath, 'preflight.require_base_fetchable');
  if (require_base_fetchable instanceof SupervisedProfileError) return require_base_fetchable;
  const require_target_branch_absent = requiredBoolean(record, 'require_target_branch_absent', sourcePath, 'preflight.require_target_branch_absent');
  if (require_target_branch_absent instanceof SupervisedProfileError) return require_target_branch_absent;
  const require_github_auth = requiredBoolean(record, 'require_github_auth', sourcePath, 'preflight.require_github_auth');
  if (require_github_auth instanceof SupervisedProfileError) return require_github_auth;
  const require_linear_auth = requiredBoolean(record, 'require_linear_auth', sourcePath, 'preflight.require_linear_auth');
  if (require_linear_auth instanceof SupervisedProfileError) return require_linear_auth;
  const require_codex_available = requiredBoolean(record, 'require_codex_available', sourcePath, 'preflight.require_codex_available');
  if (require_codex_available instanceof SupervisedProfileError) return require_codex_available;
  return { require_main_checkout_clean, require_main_checkout_on_base_branch, require_no_merge_or_rebase_in_progress, require_base_fetchable, require_target_branch_absent, require_github_auth, require_linear_auth, require_codex_available };
}


function parseAgentReview(record: Record<string, unknown> | null, sourcePath: string): ParseResult<AgentReviewConfig> {
  if (record === null) return { enabled: true, command: 'codex', model: null, timeout_seconds: 300, max_fix_attempts: 2 };
  const enabled = requiredBoolean(record, 'enabled', sourcePath, 'agent_review.enabled');
  if (enabled instanceof SupervisedProfileError) return enabled;
  const command = requiredString(record, 'command', sourcePath, 'agent_review.command');
  if (command instanceof SupervisedProfileError) return command;
  const timeout = requiredNumber(record, 'timeout_seconds', sourcePath, 'agent_review.timeout_seconds');
  if (timeout instanceof SupervisedProfileError) return timeout;
  const maxFixAttemptsValue = record.max_fix_attempts ?? 2;
  if (typeof maxFixAttemptsValue !== 'number' || !Number.isInteger(maxFixAttemptsValue) || maxFixAttemptsValue < 0) return invalid(sourcePath, 'agent_review.max_fix_attempts');
  const modelValue = record.model;
  if (modelValue !== null && typeof modelValue !== 'string') return invalid(sourcePath, 'agent_review.model');
  return { enabled, command, model: modelValue, timeout_seconds: timeout, max_fix_attempts: maxFixAttemptsValue };
}

function parseVerification(record: Record<string, unknown> | null, sourcePath: string): ParseResult<VerificationConfig> {
  if (record === null) return { enabled: false, mode: 'generic_smoke', commands: [] };
  const enabled = requiredBoolean(record, 'enabled', sourcePath, 'verification.enabled');
  if (enabled instanceof SupervisedProfileError) return enabled;
  if (record.mode !== 'ui_playwright_mcp' && record.mode !== 'backend_smoke' && record.mode !== 'generic_smoke') return invalid(sourcePath, 'verification.mode');
  if (!Array.isArray(record.commands)) return invalid(sourcePath, 'verification.commands');
  const commands = parseCommandArray(record.commands, sourcePath, 'verification.commands');
  if (commands instanceof SupervisedProfileError) return commands;
  return { enabled, mode: record.mode, commands };
}

function parseCommandArray(items: unknown[], sourcePath: string, basePath: string): ParseResult<ValidationCommand[]> {
  const commands: ValidationCommand[] = [];
  for (const [index, command] of items.entries()) {
    if (!isRecord(command)) return invalid(sourcePath, `${basePath}.${index}`);
    const name = requiredString(command, 'name', sourcePath, `${basePath}.${index}.name`);
    if (name instanceof SupervisedProfileError) return name;
    const timeout = requiredNumber(command, 'timeout_seconds', sourcePath, `${basePath}.${index}.timeout_seconds`);
    if (timeout instanceof SupervisedProfileError) return timeout;
    if ('argv' in command && !('shell' in command)) {
      const argv = requiredStringArray(command, 'argv', sourcePath, `${basePath}.${index}.argv`);
      if (argv instanceof SupervisedProfileError) return argv;
      commands.push({ name, argv, timeout_seconds: timeout });
    } else if ('shell' in command && !('argv' in command)) {
      const shell = requiredString(command, 'shell', sourcePath, `${basePath}.${index}.shell`);
      if (shell instanceof SupervisedProfileError) return shell;
      commands.push({ name, shell, timeout_seconds: timeout });
    } else {
      return invalid(sourcePath, `${basePath}.${index}`);
    }
  }
  return commands;
}

function parseValidation(record: Record<string, unknown>, sourcePath: string): ParseResult<ValidationConfig> {
  if (record.network !== 'allowed' && record.network !== 'disabled') return invalid(sourcePath, 'validation.network');
  if (!Array.isArray(record.commands)) return invalid(sourcePath, 'validation.commands');
  const commands = parseCommandArray(record.commands, sourcePath, 'validation.commands');
  if (commands instanceof SupervisedProfileError) return commands;
  return { network: record.network, commands };
}

function parseChangePolicy(record: Record<string, unknown>, sourcePath: string): ParseResult<ChangePolicyConfig> {
  const allowedValue = record.allowed_paths;
  if (allowedValue !== null && (!Array.isArray(allowedValue) || !allowedValue.every((item) => typeof item === 'string'))) return invalid(sourcePath, 'change_policy.allowed_paths');
  const allowed = allowedValue;
  const forbidden = requiredStringArray(record, 'forbidden_paths', sourcePath, 'change_policy.forbidden_paths');
  if (forbidden instanceof SupervisedProfileError) return forbidden;
  const maxBytes = requiredNumber(record, 'max_file_bytes', sourcePath, 'change_policy.max_file_bytes');
  if (maxBytes instanceof SupervisedProfileError) return maxBytes;
  const allowBinary = requiredBoolean(record, 'allow_binary_files', sourcePath, 'change_policy.allow_binary_files');
  if (allowBinary instanceof SupervisedProfileError) return allowBinary;
  return { allowed_paths: allowed, forbidden_paths: forbidden, max_file_bytes: maxBytes, allow_binary_files: allowBinary };
}

function parseGit(record: Record<string, unknown>, sourcePath: string): ParseResult<GitConfig> {
  const requireDomains = requiredStringArray(record, 'require_author_email_domains', sourcePath, 'git.require_author_email_domains');
  if (requireDomains instanceof SupervisedProfileError) return requireDomains;
  const forbidEmails = requiredStringArray(record, 'forbid_author_emails', sourcePath, 'git.forbid_author_emails');
  if (forbidEmails instanceof SupervisedProfileError) return forbidEmails;
  const authorValue = record.author;
  if (authorValue === null) return { require_author_email_domains: requireDomains, forbid_author_emails: forbidEmails, author: null };
  if (!isRecord(authorValue)) return invalid(sourcePath, 'git.author');
  const name = requiredString(authorValue, 'name', sourcePath, 'git.author.name');
  if (name instanceof SupervisedProfileError) return name;
  const email = requiredString(authorValue, 'email', sourcePath, 'git.author.email');
  if (email instanceof SupervisedProfileError) return email;
  return { require_author_email_domains: requireDomains, forbid_author_emails: forbidEmails, author: { name, email } };
}

function parseGitHub(record: Record<string, unknown>, sourcePath: string): ParseResult<GitHubConfig> {
  const createPr = requiredBoolean(record, 'create_pr', sourcePath, 'github.create_pr');
  if (createPr instanceof SupervisedProfileError) return createPr;
  if (record.draft !== false) return invalid(sourcePath, 'github.draft');
  const ciGreen = requiredBoolean(record, 'require_ci_green_before_success', sourcePath, 'github.require_ci_green_before_success');
  if (ciGreen instanceof SupervisedProfileError) return ciGreen;
  const ciTimeout = requiredNumber(record, 'ci_timeout_minutes', sourcePath, 'github.ci_timeout_minutes');
  if (ciTimeout instanceof SupervisedProfileError) return ciTimeout;
  const ciPoll = requiredNumber(record, 'ci_poll_interval_seconds', sourcePath, 'github.ci_poll_interval_seconds');
  if (ciPoll instanceof SupervisedProfileError) return ciPoll;
  const prMax = requiredNumber(record, 'pr_body_max_chars', sourcePath, 'github.pr_body_max_chars');
  if (prMax instanceof SupervisedProfileError) return prMax;

  const requiredChecks = requiredRecord(record, 'required_checks', sourcePath, 'github.required_checks');
  if (requiredChecks instanceof SupervisedProfileError) return requiredChecks;
  if (requiredChecks.mode !== 'github_required_checks' && requiredChecks.mode !== 'explicit') return invalid(sourcePath, 'github.required_checks.mode');
  const fallback = requiredStringArray(requiredChecks, 'fallback', sourcePath, 'github.required_checks.fallback');
  if (fallback instanceof SupervisedProfileError) return fallback;

  const labels = requiredRecord(record, 'labels', sourcePath, 'github.labels');
  if (labels instanceof SupervisedProfileError) return labels;
  const labelBestEffort = requiredBoolean(labels, 'best_effort', sourcePath, 'github.labels.best_effort');
  if (labelBestEffort instanceof SupervisedProfileError) return labelBestEffort;
  const createMissing = requiredBoolean(labels, 'create_missing', sourcePath, 'github.labels.create_missing');
  if (createMissing instanceof SupervisedProfileError) return createMissing;
  const labelNames = requiredStringArray(labels, 'names', sourcePath, 'github.labels.names');
  if (labelNames instanceof SupervisedProfileError) return labelNames;

  const reviewers = requiredRecord(record, 'reviewers', sourcePath, 'github.reviewers');
  if (reviewers instanceof SupervisedProfileError) return reviewers;
  const reviewerUsers = requiredStringArray(reviewers, 'users', sourcePath, 'github.reviewers.users');
  if (reviewerUsers instanceof SupervisedProfileError) return reviewerUsers;
  const reviewerTeams = requiredStringArray(reviewers, 'teams', sourcePath, 'github.reviewers.teams');
  if (reviewerTeams instanceof SupervisedProfileError) return reviewerTeams;
  const reviewerBestEffort = requiredBoolean(reviewers, 'best_effort', sourcePath, 'github.reviewers.best_effort');
  if (reviewerBestEffort instanceof SupervisedProfileError) return reviewerBestEffort;

  const assignees = requiredRecord(record, 'assignees', sourcePath, 'github.assignees');
  if (assignees instanceof SupervisedProfileError) return assignees;
  const assigneeUsers = requiredStringArray(assignees, 'users', sourcePath, 'github.assignees.users');
  if (assigneeUsers instanceof SupervisedProfileError) return assigneeUsers;
  const assigneeBestEffort = requiredBoolean(assignees, 'best_effort', sourcePath, 'github.assignees.best_effort');
  if (assigneeBestEffort instanceof SupervisedProfileError) return assigneeBestEffort;

  return {
    create_pr: createPr,
    draft: false,
    require_ci_green_before_success: ciGreen,
    ci_timeout_minutes: ciTimeout,
    ci_poll_interval_seconds: ciPoll,
    required_checks: { mode: requiredChecks.mode, fallback },
    labels: { best_effort: labelBestEffort, create_missing: createMissing, names: labelNames },
    reviewers: { users: reviewerUsers, teams: reviewerTeams, best_effort: reviewerBestEffort },
    assignees: { users: assigneeUsers, best_effort: assigneeBestEffort },
    pr_body_max_chars: prMax,
  };
}

function parseRun(record: Record<string, unknown>, sourcePath: string): ParseResult<RunConfig> {
  const maxTotal = requiredNumber(record, 'max_total_minutes', sourcePath, 'run.max_total_minutes');
  return maxTotal instanceof SupervisedProfileError ? maxTotal : { max_total_minutes: maxTotal };
}

function parseCleanup(record: Record<string, unknown>, sourcePath: string): ParseResult<CleanupConfig> {
  const deleteLocalBranch = requiredBoolean(record, 'delete_local_branch_on_success', sourcePath, 'cleanup.delete_local_branch_on_success');
  if (deleteLocalBranch instanceof SupervisedProfileError) return deleteLocalBranch;
  const deleteLocalWorktree = requiredBoolean(record, 'delete_local_worktree_on_success', sourcePath, 'cleanup.delete_local_worktree_on_success');
  if (deleteLocalWorktree instanceof SupervisedProfileError) return deleteLocalWorktree;
  const deleteRemoteBranch = requiredBoolean(record, 'delete_remote_branch_on_success', sourcePath, 'cleanup.delete_remote_branch_on_success');
  if (deleteRemoteBranch instanceof SupervisedProfileError) return deleteRemoteBranch;
  const deleteRunRecord = requiredBoolean(record, 'delete_run_record_on_success', sourcePath, 'cleanup.delete_run_record_on_success');
  if (deleteRunRecord instanceof SupervisedProfileError) return deleteRunRecord;
  const keepLocalFailure = requiredBoolean(record, 'keep_local_branch_on_failure', sourcePath, 'cleanup.keep_local_branch_on_failure');
  if (keepLocalFailure instanceof SupervisedProfileError) return keepLocalFailure;
  const keepLocalWarning = requiredBoolean(record, 'keep_local_branch_on_warning', sourcePath, 'cleanup.keep_local_branch_on_warning');
  if (keepLocalWarning instanceof SupervisedProfileError) return keepLocalWarning;
  return {
    delete_local_branch_on_success: deleteLocalBranch,
    delete_local_worktree_on_success: deleteLocalWorktree,
    delete_remote_branch_on_success: deleteRemoteBranch,
    delete_run_record_on_success: deleteRunRecord,
    keep_local_branch_on_failure: keepLocalFailure,
    keep_local_branch_on_warning: keepLocalWarning,
  };
}

function optionalRecord(record: Record<string, unknown>, key: string, sourcePath: string): ParseResult<Record<string, unknown> | null> {
  if (!(key in record) || record[key] === null) return null;
  if (!isRecord(record[key])) return invalid(sourcePath, key);
  return record[key];
}

function requiredRecord(record: Record<string, unknown>, key: string, sourcePath: string, field = key): ParseResult<Record<string, unknown>> {
  const value = record[key];
  return isRecord(value) ? value : invalid(sourcePath, field);
}

function requiredString(record: Record<string, unknown>, key: string, sourcePath: string, field = key): ParseResult<string> {
  return typeof record[key] === 'string' ? record[key] : invalid(sourcePath, field);
}

function requiredNumber(record: Record<string, unknown>, key: string, sourcePath: string, field = key): ParseResult<number> {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : invalid(sourcePath, field);
}

function requiredBoolean(record: Record<string, unknown>, key: string, sourcePath: string, field = key): ParseResult<boolean> {
  return typeof record[key] === 'boolean' ? record[key] : invalid(sourcePath, field);
}

function requiredStringArray(record: Record<string, unknown>, key: string, sourcePath: string, field = key): ParseResult<string[]> {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : invalid(sourcePath, field);
}

function invalid(sourcePath: string, field: string): SupervisedProfileError {
  return err('profile_field_invalid', `Invalid profile field: ${field}`, sourcePath, field);
}

function err(code: ConstructorParameters<typeof SupervisedProfileError>[0], message: string, sourcePath: string, field?: string): SupervisedProfileError {
  return field === undefined ? new SupervisedProfileError(code, message, { path: sourcePath }) : new SupervisedProfileError(code, message, { path: sourcePath, field });
}

function fail(code: ConstructorParameters<typeof SupervisedProfileError>[0], message: string, opts: { path?: string; field?: string } = {}): ProfileLoadResult {
  return { ok: false, error: new SupervisedProfileError(code, message, opts) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
