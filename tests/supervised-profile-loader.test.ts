import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSupervisedProfile, profilePath } from '../src/supervised/profile/loader.js';

const VALID_PROFILE = `
schema_version: 1
name: p
repo:
  path: /tmp/repo
  remote: origin
  base_branch: main
linear:
  team: ENG
  project: null
  eligible_status: Todo
  claim_status: In Progress
  success_status: Ready for Review
  failure_status: null
  require_unassigned: true
  required_labels: []
  include_comments: true
  max_comments: 20
  comment_order: chronological
  include_attachment_links: true
  download_attachments: false
  comment_max_chars: 8000
  output_tail_max_lines: 80
  assignee:
    mode: authenticated_user
agent:
  kind: codex
  command: codex
  model: gpt-5.5
  timeout_minutes: 60
  allow_network: true
  allow_web_lookup: true
  allow_browser_automation: false
prompt:
  include_repo_instruction_files: []
  repo_instruction_max_chars: 20000
  extra_instructions: null
preflight:
  require_main_checkout_clean: true
  require_main_checkout_on_base_branch: true
  require_no_merge_or_rebase_in_progress: true
  require_base_fetchable: true
  require_target_branch_absent: true
  require_github_auth: true
  require_linear_auth: true
  require_codex_available: true
validation:
  network: allowed
  commands: []
change_policy:
  allowed_paths: null
  forbidden_paths: []
  max_file_bytes: 1000000
  allow_binary_files: false
git:
  require_author_email_domains: []
  forbid_author_emails: []
  author: null
github:
  create_pr: true
  draft: false
  require_ci_green_before_success: true
  ci_timeout_minutes: 30
  ci_poll_interval_seconds: 30
  required_checks:
    mode: github_required_checks
    fallback: []
  labels:
    best_effort: true
    create_missing: false
    names: []
  reviewers:
    users: []
    teams: []
    best_effort: true
  assignees:
    users: []
    best_effort: true
  pr_body_max_chars: 12000
run:
  max_total_minutes: 100
cleanup:
  delete_local_branch_on_success: true
  delete_local_worktree_on_success: true
  delete_remote_branch_on_success: false
  delete_run_record_on_success: false
  keep_local_branch_on_failure: true
  keep_local_branch_on_warning: true
`;

async function writeProfile(name: string, content: string): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'symphony-profile-loader-'));
  const dir = join(homeDir, '.symphony', 'profiles');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.yaml`), content);
  return homeDir;
}

describe('profilePath', () => {
  it('resolves profile names under ~/.symphony/profiles', () => {
    expect(profilePath('marketsavvy', '/home/me')).toBe('/home/me/.symphony/profiles/marketsavvy.yaml');
  });
});

describe('loadSupervisedProfile', () => {
  it('loads a valid v1 profile and returns a stable hash', async () => {
    const homeDir = await writeProfile('valid', VALID_PROFILE);

    const result = await loadSupervisedProfile('valid', { homeDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.profile.agent.kind).toBe('codex');
    expect(result.profile.agent_review.max_fix_attempts).toBe(2);
    expect(result.profile.verification.enabled).toBe(false);
    expect(result.sourcePath).toBe(profilePath('valid', homeDir));
    expect(result.resolvedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a profile missing schema_version', async () => {
    const homeDir = await writeProfile('bad', VALID_PROFILE.replace('schema_version: 1\n', ''));

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('profile_schema_version_missing');
  });

  it('rejects unsupported schema_version', async () => {
    const homeDir = await writeProfile('bad', VALID_PROFILE.replace('schema_version: 1', 'schema_version: 2'));

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('profile_schema_version_unsupported');
  });

  it('rejects non-codex agents in v1', async () => {
    const homeDir = await writeProfile('bad', VALID_PROFILE.replace('kind: codex', 'kind: claude'));

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('agent_kind_unsupported');
  });

  it('rejects relative repo.path', async () => {
    const homeDir = await writeProfile('bad', VALID_PROFILE.replace('path: /tmp/repo', 'path: ./repo'));

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('repo_path_not_absolute');
  });

  it('rejects unknown top-level keys', async () => {
    const homeDir = await writeProfile('bad', `${VALID_PROFILE}\nextra: true\n`);

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('profile_unknown_key');
  });

  it('validates validation command shape', async () => {
    const homeDir = await writeProfile('bad', VALID_PROFILE.replace('commands: []', 'commands:\n  - name: bad'));

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('profile_field_invalid');
    expect(result.error.field).toBe('validation.commands.0.timeout_seconds');
  });

  it('validates agent_review.max_fix_attempts shape', async () => {
    const homeDir = await writeProfile('bad', `${VALID_PROFILE}\nagent_review: { enabled: true, command: codex, model: gpt-5.5, timeout_seconds: 300, max_fix_attempts: -1 }\n`);

    const result = await loadSupervisedProfile('bad', { homeDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('profile_field_invalid');
    expect(result.error.field).toBe('agent_review.max_fix_attempts');
  });

  it('canonicalizes absolute repo.path values', async () => {
    const homeDir = await writeProfile('valid', VALID_PROFILE.replace('path: /tmp/repo', 'path: /tmp/../tmp/repo'));

    const result = await loadSupervisedProfile('valid', { homeDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.profile.repo.path).toBe('/tmp/repo');
  });
});
