export type RunStatus =
  | 'dry_run'
  | 'refused'
  | 'preflight_failed'
  | 'initialized'
  | 'preflight_running'
  | 'candidate_selected'
  | 'claimed'
  | 'codex_running'
  | 'codex_completed'
  | 'code_review_running'
  | 'review_remediation_running'
  | 'review_remediation_completed'
  | 'code_review_completed'
  | 'verification_running'
  | 'verification_completed'
  | 'validation_running'
  | 'validation_completed'
  | 'handoff_running'
  | 'pr_created'
  | 'ci_running'
  | 'ci_completed'
  | 'succeeded'
  | 'succeeded_with_warnings'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type RunReason =
  | 'no_candidates'
  | 'multiple_candidates'
  | 'issue_not_eligible'
  | 'issue_changed_before_claim'
  | 'claim_verification_failed'
  | 'repo_path_not_absolute'
  | 'repo_is_bare'
  | 'repo_dirty'
  | 'wrong_base_branch'
  | 'base_diverged'
  | 'base_moved_during_run'
  | 'final_fetch_failed'
  | 'branch_exists'
  | 'lock_exists'
  | 'codex_unavailable'
  | 'codex_noninteractive_unavailable'
  | 'codex_version_too_old'
  | 'codex_timeout'
  | 'codex_log_capture_failed'
  | 'worktree_creation_failed'
  | 'no_commit'
  | 'dirty_worktree_after_codex'
  | 'dirty_worktree_after_validation'
  | 'change_policy_failed'
  | 'commit_message_policy_failed'
  | 'code_review_failed'
  | 'dirty_worktree_after_review'
  | 'smoke_verification_failed'
  | 'dirty_worktree_after_verification'
  | 'validation_failed'
  | 'pr_creation_failed'
  | 'ci_failed'
  | 'ci_timeout'
  | 'linear_handoff_failed'
  | 'post_claim_unhandled_error'
  | 'resume_preflight_failed'
  | 'resume_integrity_check_failed'
  | 'manual_cancelled'
  | 'profile_schema_version_missing';

export interface RunRecord {
  schema_version: 1;
  run_id: string;
  run_dir: string;
  profile_name: string;
  profile_hash: string;
  issue_key: string | null;
  mutating: boolean;
  status: RunStatus;
  reason: RunReason | null;
  created_at: string;
  updated_at: string;
  artifacts_path: string;
  events_path: string;
}

export interface RunEvent {
  schema_version: 1;
  event_id: string;
  run_id: string;
  timestamp: string;
  type: 'run_created' | 'transition' | 'side_effect' | 'artifact' | 'warning';
  data: Record<string, unknown>;
}

export interface RunArtifact {
  path: string;
  visibility: 'local_only' | 'redacted_shareable' | 'github_visible' | 'linear_visible';
  kind: string;
}

export interface ArtifactsManifest {
  schema_version: 1;
  run_id: string;
  artifacts: RunArtifact[];
}

export interface CreateRunRecordOptions {
  homeDir: string;
  runId?: string;
  profileName: string;
  profileHash: string;
  issueKey: string | null;
  mutating: boolean;
  now?: Date;
}
