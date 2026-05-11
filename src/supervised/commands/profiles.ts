import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { EXIT_CONFIG_OR_SCHEMA, EXIT_SUCCEEDED } from '../exit-codes.js';
import { isSafeProfileName, loadSupervisedProfile, profilePath } from '../profile/loader.js';
import type { SupervisedProfile } from '../profile/types.js';

export interface ProfilesCommandOptions {
  argv: string[];
  homeDir?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface ProfilesCommandResult {
  exitCode: number;
}

export async function handleProfilesCommand(opts: ProfilesCommandOptions): Promise<ProfilesCommandResult> {
  const [subcommand, ...rest] = opts.argv;
  switch (subcommand) {
    case 'init':
      return initProfile(rest, opts);
    case 'validate':
      return validateProfile(rest, opts);
    case 'show':
      return showProfile(rest, opts);
    case 'list':
      return listProfiles(rest, opts);
    default:
      opts.stderr('Usage: symphony profiles <init|validate|show|list> ...\n');
      return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
}

async function initProfile(argv: string[], opts: ProfilesCommandOptions): Promise<ProfilesCommandResult> {
  const name = argv[0];
  if (!name) {
    opts.stderr('Usage: symphony profiles init <name> [--repo <absolute-path>]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  if (!isSafeProfileName(name)) {
    opts.stderr('profiles init: profile name may only contain letters, numbers, dots, underscores, and hyphens\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const repo = readFlag(argv.slice(1), '--repo') ?? process.cwd();
  const canonicalRepo = path.resolve(repo);

  const homeDir = opts.homeDir ?? os.homedir();
  const target = profilePath(name, homeDir);
  if (existsSync(target)) {
    opts.stderr(`profiles init: profile already exists: ${target}\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderProfileTemplate(name, canonicalRepo));
  opts.stdout(`Created ${target}\n`);
  return { exitCode: EXIT_SUCCEEDED };
}

function validateProfile(argv: string[], opts: ProfilesCommandOptions): ProfilesCommandResult {
  const name = argv[0];
  if (!name) {
    opts.stderr('Usage: symphony profiles validate <name> [--json]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const json = argv.includes('--json');
  const result = loadSupervisedProfile(name, loadOpts(opts));
  if (!result.ok) {
    if (json) opts.stdout(`${JSON.stringify({ ok: false, error: serializeError(result.error) })}\n`);
    else opts.stderr(`Profile ${name} invalid: ${result.error.code}: ${result.error.message}\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  if (json) opts.stdout(`${JSON.stringify({ ok: true, name: result.profile.name, sourcePath: result.sourcePath, resolvedHash: result.resolvedHash })}\n`);
  else opts.stdout(`Profile ${name} valid\n`);
  return { exitCode: EXIT_SUCCEEDED };
}

function showProfile(argv: string[], opts: ProfilesCommandOptions): ProfilesCommandResult {
  const name = argv[0];
  if (!name) {
    opts.stderr('Usage: symphony profiles show <name> [--json]\n');
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const json = argv.includes('--json');
  const result = loadSupervisedProfile(name, loadOpts(opts));
  if (!result.ok) {
    opts.stderr(`Profile ${name} invalid: ${result.error.code}: ${result.error.message}\n`);
    return { exitCode: EXIT_CONFIG_OR_SCHEMA };
  }
  const redacted = redactProfile(result.profile);
  if (json) {
    opts.stdout(`${JSON.stringify({ profile: redacted, sourcePath: result.sourcePath, resolvedHash: result.resolvedHash }, null, 2)}\n`);
  } else {
    opts.stdout(yaml.dump(redacted, { lineWidth: 120 }));
  }
  return { exitCode: EXIT_SUCCEEDED };
}

async function listProfiles(argv: string[], opts: ProfilesCommandOptions): Promise<ProfilesCommandResult> {
  const json = argv.includes('--json');
  const homeDir = opts.homeDir ?? os.homedir();
  const dir = path.join(homeDir, '.symphony', 'profiles');
  let names: string[] = [];
  try {
    const entries = await readdir(dir);
    names = entries
      .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
      .map((entry) => entry.replace(/\.ya?ml$/u, ''))
      .sort();
  } catch {
    names = [];
  }
  opts.stdout(json ? `${JSON.stringify({ profiles: names })}\n` : names.map((name) => `${name}\n`).join(''));
  return { exitCode: EXIT_SUCCEEDED };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function loadOpts(opts: ProfilesCommandOptions): { homeDir?: string } {
  return opts.homeDir === undefined ? {} : { homeDir: opts.homeDir };
}

function serializeError(error: Error & { code?: string; field?: string; path?: string }) {
  return { code: error.code, message: error.message, field: error.field, path: error.path };
}

function redactProfile(profile: SupervisedProfile): SupervisedProfile {
  return structuredClone(profile);
}

function renderProfileTemplate(name: string, repoPath: string): string {
  return `schema_version: 1
name: ${JSON.stringify(name)}
repo:
  path: ${JSON.stringify(repoPath)}
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
knowledge:
  enabled: true
  include:
    - PROJECT-BRIEF.md
    - docs/specs/*.md
    - docs/adr/*.md
    - docs/architecture/*.md
    - docs/user-flows/*.md
    - docs/development/*.md
    - docs/runbooks/*.md
    - docs/verification/*.md
    - docs/api/*.md
  max_bytes: 80000
agent_review:
  enabled: true
  command: codex
  model: null
  timeout_seconds: 300
  max_fix_attempts: 2
verification:
  enabled: false
  mode: generic_smoke
  commands: []
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
}
