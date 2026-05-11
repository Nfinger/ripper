export type AgentKind = 'codex';
export type ValidationNetworkPolicy = 'allowed' | 'disabled';
export type VerificationMode = 'ui_playwright_mcp' | 'backend_smoke' | 'generic_smoke';

export interface SupervisedProfile {
  schema_version: 1;
  name: string;
  repo: RepoConfig;
  linear: LinearConfig;
  agent: AgentConfig;
  prompt: PromptConfig;
  knowledge: KnowledgeConfig;
  preflight: PreflightConfig;
  agent_review: AgentReviewConfig;
  verification: VerificationConfig;
  validation: ValidationConfig;
  change_policy: ChangePolicyConfig;
  git: GitConfig;
  github: GitHubConfig;
  run: RunConfig;
  cleanup: CleanupConfig;
}

export interface RepoConfig {
  path: string;
  remote: string;
  base_branch: string;
}

export type LinearAssigneeConfig =
  | { mode: 'authenticated_user' }
  | { mode: 'user_id'; user_id: string };

export interface LinearConfig {
  team: string;
  project: string | null;
  eligible_status: string;
  claim_status: string;
  success_status: string;
  failure_status: string | null;
  require_unassigned: boolean;
  required_labels: string[];
  include_comments: boolean;
  max_comments: number;
  comment_order: 'chronological' | 'reverse_chronological';
  include_attachment_links: boolean;
  download_attachments: boolean;
  comment_max_chars: number;
  output_tail_max_lines: number;
  assignee: LinearAssigneeConfig;
}

export interface AgentConfig {
  kind: AgentKind;
  command: string;
  model: string | null;
  min_version?: string;
  timeout_minutes: number;
  allow_network: boolean;
  allow_web_lookup: boolean;
  allow_browser_automation: false;
}

export interface PromptConfig {
  include_repo_instruction_files: string[];
  repo_instruction_max_chars: number;
  extra_instructions: string | null;
}

export interface KnowledgeConfig {
  enabled: boolean;
  include: string[];
  max_bytes: number;
}

export interface PreflightConfig {
  require_main_checkout_clean: boolean;
  require_main_checkout_on_base_branch: boolean;
  require_no_merge_or_rebase_in_progress: boolean;
  require_base_fetchable: boolean;
  require_target_branch_absent: boolean;
  require_github_auth: boolean;
  require_linear_auth: boolean;
  require_codex_available: boolean;
}

export type ValidationCommand =
  | { name: string; argv: string[]; timeout_seconds: number }
  | { name: string; shell: string; timeout_seconds: number };

export interface AgentReviewConfig {
  enabled: boolean;
  command: string;
  model: string | null;
  timeout_seconds: number;
  max_fix_attempts: number;
}

export interface VerificationConfig {
  enabled: boolean;
  mode: VerificationMode;
  commands: ValidationCommand[];
}

export interface ValidationConfig {
  network: ValidationNetworkPolicy;
  commands: ValidationCommand[];
}

export interface ChangePolicyConfig {
  allowed_paths: string[] | null;
  forbidden_paths: string[];
  max_file_bytes: number;
  allow_binary_files: boolean;
}

export interface GitConfig {
  require_author_email_domains: string[];
  forbid_author_emails: string[];
  author: GitAuthorConfig | null;
}

export interface GitAuthorConfig {
  name: string;
  email: string;
}

export interface GitHubRequiredChecksConfig {
  mode: 'github_required_checks' | 'explicit';
  fallback: string[];
}

export interface GitHubLabelsConfig {
  best_effort: boolean;
  create_missing: boolean;
  names: string[];
}

export interface GitHubReviewersConfig {
  users: string[];
  teams: string[];
  best_effort: boolean;
}

export interface GitHubAssigneesConfig {
  users: string[];
  best_effort: boolean;
}

export interface GitHubConfig {
  create_pr: boolean;
  draft: false;
  require_ci_green_before_success: boolean;
  ci_timeout_minutes: number;
  ci_poll_interval_seconds: number;
  required_checks: GitHubRequiredChecksConfig;
  labels: GitHubLabelsConfig;
  reviewers: GitHubReviewersConfig;
  assignees: GitHubAssigneesConfig;
  pr_body_max_chars: number;
}

export interface RunConfig {
  max_total_minutes: number;
}

export interface CleanupConfig {
  delete_local_branch_on_success: boolean;
  delete_local_worktree_on_success: boolean;
  delete_remote_branch_on_success: boolean;
  delete_run_record_on_success: boolean;
  keep_local_branch_on_failure: boolean;
  keep_local_branch_on_warning: boolean;
}

export const SUPERVISED_PROFILE_SCHEMA_VERSION = 1;
