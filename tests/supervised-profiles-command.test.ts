import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleProfilesCommand } from '../src/supervised/commands/profiles.js';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_SUCCEEDED } from '../src/supervised/exit-codes.js';

const VALID_PROFILE = `
schema_version: 1
name: valid
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

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-profiles-command-'));
}

async function writeProfile(homeDir: string, name: string, content = VALID_PROFILE): Promise<void> {
  const dir = join(homeDir, '.symphony', 'profiles');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.yaml`), content);
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
    get stdoutText() {
      return stdout;
    },
    get stderrText() {
      return stderr;
    },
  };
}

describe('handleProfilesCommand', () => {
  it('profiles init <name> creates a profile and refuses overwrite', async () => {
    const homeDir = await tempHome();
    const io = capture();

    const created = await handleProfilesCommand({ argv: ['init', 'new-profile'], homeDir, ...io });
    const repeated = await handleProfilesCommand({ argv: ['init', 'new-profile'], homeDir, ...io });

    expect(created.exitCode).toBe(EXIT_SUCCEEDED);
    expect(repeated.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    const written = await readFile(join(homeDir, '.symphony', 'profiles', 'new-profile.yaml'), 'utf8');
    expect(written).toContain('schema_version: 1');
    expect(written).toContain('name: \"new-profile\"');
  });

  it('profiles init rejects unsafe profile names', async () => {
    const homeDir = await tempHome();
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['init', '../escape'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    expect(io.stderrText).toContain('profile name');
  });

  it('profiles init <name> --repo <path> writes canonical absolute repo path', async () => {
    const homeDir = await tempHome();
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['init', 'repo-profile', '--repo', '/tmp/../tmp/repo'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    const written = await readFile(join(homeDir, '.symphony', 'profiles', 'repo-profile.yaml'), 'utf8');
    expect(written).toContain('path: \"/tmp/repo\"');
  });

  it('profiles validate rejects unsafe profile names', async () => {
    const homeDir = await tempHome();
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['validate', '../escape'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
    expect(io.stderrText).toContain('profile_name_invalid');
  });

  it('profiles validate <name> returns 0 for valid profile', async () => {
    const homeDir = await tempHome();
    await writeProfile(homeDir, 'valid');
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['validate', 'valid'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    expect(io.stdoutText).toContain('valid');
  });

  it('profiles show <name> prints redacted profile JSON with --json', async () => {
    const homeDir = await tempHome();
    await writeProfile(homeDir, 'valid');
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['show', 'valid', '--json'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    const parsed = JSON.parse(io.stdoutText) as { profile: { name: string }; resolvedHash: string };
    expect(parsed.profile.name).toBe('valid');
    expect(parsed.resolvedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('profiles list lists yaml profile names', async () => {
    const homeDir = await tempHome();
    await writeProfile(homeDir, 'b');
    await writeProfile(homeDir, 'a');
    const io = capture();

    const result = await handleProfilesCommand({ argv: ['list'], homeDir, ...io });

    expect(result.exitCode).toBe(EXIT_SUCCEEDED);
    expect(io.stdoutText.trim().split('\n')).toEqual(['a', 'b']);
  });
});
