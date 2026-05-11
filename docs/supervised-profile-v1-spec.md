# Symphony Supervised Profile v1 Spec

**Status:** Draft v1 implementation spec  
**Scope:** one-ticket supervised Codex runs from Linear to GitHub PR handoff  
**Primary principle:** Symphony owns deterministic orchestration and external side effects; Codex owns one bounded implementation attempt and commits.

---

## 1. Goal

Build a conservative supervised runner for coding agents:

```text
symphony run <profile>
  -> load explicit profile
  -> create durable local run record
  -> find exactly one eligible Linear issue
  -> run readiness preflight
  -> claim the issue
  -> create deterministic branch + per-run worktree
  -> generate bounded Codex prompt
  -> run one non-interactive Codex attempt
  -> verify commits, diff safety, and clean worktree
  -> run profile-defined validation
  -> push branch + create non-draft GitHub PR
  -> wait for required GitHub CI
  -> move Linear issue to success status + post handoff
  -> clean successful local branch/worktree
```

v1 is intentionally boring: no broad backlog autonomy, no multi-ticket batching, no auto-merge, no release/deploy, no hidden setup hooks, and no external side effects by Codex.

---

## 2. Non-goals

Symphony v1 does **not** support:

- multiple issues per run
- autonomous issue selection by Codex
- multiple implementation agents; only `agent.kind: codex`
- interactive Codex/TUI mode
- built-in scheduler/daemon
- profile inheritance / `extends`
- profile environment-variable interpolation
- generic setup commands before Codex
- Symphony auto-committing dirty Codex worktrees
- pushing before local validation/safety gates pass
- auto-merge
- release/tag/deploy/post-merge automation
- GitHub Projects or PR milestones
- raw-log export bundles
- remote branch deletion

---

## 3. Command surface

### Primary run commands

```bash
symphony run <profile>
symphony run <profile> --issue <LINEAR-KEY>
symphony run <profile> --dry-run
symphony run <profile> --issue <LINEAR-KEY> --dry-run
symphony run <profile> --no-interactive
symphony --no-interactive run <profile>
```

`--issue` is a narrowing mechanism only. The issue must still pass every profile eligibility gate.

### Profile commands

```bash
symphony profiles init <profile>
symphony profiles init <profile> --repo <absolute-or-relative-path>
symphony profiles init <profile> --linear-team ENG --linear-project MarketSavvy --linear-label symphony
symphony profiles validate <profile>
symphony profiles doctor <profile>
symphony profiles doctor <profile> --json
symphony profiles list
symphony profiles show <profile>
```

### Run inspection/recovery commands

```bash
symphony runs list
symphony runs list --profile <profile> --status failed --limit 20
symphony runs list --json

symphony runs show <run_id>
symphony runs show --latest
symphony runs show --latest --profile <profile>
symphony runs show <run_id> --json

symphony runs verify <run_id>
symphony runs verify <run_id> --json
symphony runs resume <run_id>
symphony runs cancel <run_id> --reason "..."
symphony runs rebuild-index
symphony runs cleanup --older-than 30d --status succeeded
symphony runs cleanup --older-than 30d --status succeeded --apply
symphony runs export <run_id>
symphony runs export <run_id> --json
```

### Lock commands

```bash
symphony locks list
symphony locks show <lock_id>
symphony locks unlock <lock_id> --reason "..."
```

---

## 4. Profile schema

Profiles live centrally under:

```text
~/.symphony/profiles/<profile>.yaml
```

Each profile is a complete explicit YAML file. There is no inheritance and no env interpolation.

### Example profile

```yaml
schema_version: 1
name: marketsavvy-codex

repo:
  path: /Users/homebase/marketsavvy
  remote: origin
  base_branch: main

linear:
  team: MarketSavvy
  project: MarketSavvy
  eligible_status: Todo
  claim_status: In Progress
  success_status: Ready for Review
  failure_status: null
  require_unassigned: true
  required_labels:
    - symphony
    - codex
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
  min_version: "0.129.0"
  allow_network: true
  allow_web_lookup: true
  allow_browser_automation: false

agent_review:
  enabled: true
  command: codex
  model: gpt-5.5
  timeout_seconds: 300

prompt:
  include_repo_instruction_files:
    - AGENTS.md
    - CLAUDE.md
    - .cursorrules
    - CONTRIBUTING.md
  repo_instruction_max_chars: 20000
  extra_instructions: |
    Prefer small, reviewable changes.
    Do not introduce dependencies unless necessary.

preflight:
  require_main_checkout_clean: true
  require_main_checkout_on_base_branch: true
  require_no_merge_or_rebase_in_progress: true
  require_base_fetchable: true
  require_target_branch_absent: true
  require_github_auth: true
  require_linear_auth: true
  require_codex_available: true

verification:
  enabled: true
  mode: ui_playwright_mcp # ui_playwright_mcp | backend_smoke | generic_smoke
  commands:
    - name: playwright mcp smoke
      shell: "pnpm exec playwright test --project=chromium"
      timeout_seconds: 300

validation:
  network: allowed
  commands:
    - name: unit tests
      argv: ["npm", "test"]
      timeout_seconds: 300
    - name: typecheck
      shell: "npm run typecheck"
      timeout_seconds: 300

change_policy:
  allowed_paths: null
  forbidden_paths:
    - .env
    - .env.*
    - "**/*.pem"
    - "**/*.key"
    - "**/id_rsa"
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
    names:
      - symphony
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
```

### Schema rules

- `schema_version: 1` is required once v1 is formalized.
- Missing version fails with `profile_schema_version_missing`.
- Unsupported versions fail schema validation.
- `repo.path` must be absolute and canonicalized.
- `repo.path` must be a normal non-bare Git working checkout.
- Relative repo paths fail with `repo_path_not_absolute`.
- Bare repositories fail with `repo_is_bare`.
- `linear.claim_status` and `linear.success_status` are required.
- `linear.failure_status` defaults to `null` and means no automatic failure status move.
- `linear.assignee` must be explicit, even for `authenticated_user`.
- `agent.kind` must be `codex` in v1.
- Unknown profile keys should fail validation unless deliberately reserved.

---

## 5. State and reason model

Use a coarse `status` plus machine-readable `reason`.

```json
{ "status": "failed", "reason": "validation_failed" }
```

### Statuses

```text
dry_run
refused
preflight_failed
initialized
preflight_running
candidate_selected
claimed
codex_running
codex_completed
code_review_running
code_review_completed
verification_running
verification_completed
validation_running
validation_completed
handoff_running
pr_created
ci_running
ci_completed
succeeded
succeeded_with_warnings
failed
timed_out
cancelled
```

### Common reasons

```text
no_candidates
multiple_candidates
issue_not_eligible
issue_changed_before_claim
claim_verification_failed
repo_path_not_absolute
repo_is_bare
repo_dirty
wrong_base_branch
base_diverged
base_moved_during_run
final_fetch_failed
branch_exists
lock_exists
codex_unavailable
codex_noninteractive_unavailable
codex_version_too_old
codex_timeout
no_commit
dirty_worktree_after_codex
dirty_worktree_after_review
dirty_worktree_after_verification
dirty_worktree_after_validation
change_policy_failed
commit_message_policy_failed
code_review_failed
smoke_verification_failed
validation_failed
pr_creation_failed
ci_failed
ci_timeout
linear_handoff_failed
resume_preflight_failed
resume_integrity_check_failed
manual_cancelled
profile_schema_version_missing
```

---

## 6. State machine

All state changes go through one central transition function, e.g. `transition_run(...)`.

The implementation keeps a data-driven transition table with:

- allowed next states
- allowed side effects per state
- required event names
- artifacts written
- cleanup behavior

Invalid transitions fail loudly.

### High-level transitions

```text
initialized
  -> refused
  -> preflight_running

preflight_running
  -> preflight_failed
  -> candidate_selected

candidate_selected
  -> refused
  -> claimed

claimed
  -> codex_running
  -> failed
  -> cancelled

codex_running
  -> codex_completed
  -> failed
  -> timed_out
  -> cancelled

codex_completed
  -> code_review_running
  -> verification_running
  -> validation_running
  -> failed

code_review_running
  -> code_review_completed
  -> failed

code_review_completed
  -> verification_running
  -> validation_running
  -> failed

verification_running
  -> verification_completed
  -> failed

verification_completed
  -> validation_running
  -> handoff_running
  -> failed

validation_running
  -> validation_completed
  -> failed
  -> timed_out

validation_completed
  -> handoff_running
  -> failed

handoff_running
  -> ci_running
  -> failed
  -> succeeded_with_warnings

ci_running
  -> succeeded
  -> succeeded_with_warnings
  -> failed
  -> timed_out

succeeded | succeeded_with_warnings | failed | timed_out | cancelled | refused | preflight_failed | dry_run
  -> terminal
```

Every transition appends a `transition` event and atomically updates `run.json`.

---

## 7. Events

`events.jsonl` is an append-only audit API, not freeform logging.

Each event is one JSON object per line:

```json
{
  "schema_version": 1,
  "event_id": "...",
  "run_id": "...",
  "timestamp": "2026-05-10T02:10:00Z",
  "type": "transition",
  "data": {}
}
```

Event requirements:

- every event has `schema_version`
- every event has unique `event_id`
- every event has `run_id`
- timestamps are ISO-8601 UTC
- future unknown versions fail gracefully or warn depending on command

### Side-effect events

Record mutations separately from transitions:

```json
{"type":"transition","data":{"from":"claimed","to":"codex_running","reason":null}}
{"type":"side_effect","data":{"name":"linear.status_updated","target":"MS-123","result":"ok"}}
{"type":"side_effect","data":{"name":"github.pr_created","target":"https://github.com/.../pull/123","result":"ok"}}
{"type":"side_effect","data":{"name":"git.branch_pushed","target":"origin/symphony/MS-123-slug","result":"ok"}}
```

Rules:

- no secrets in event payloads
- include safe IDs/URLs when useful
- record failures too
- resume/recovery reads actual side effects, not just final status

---

## 8. Run records

Default storage:

```text
~/.symphony/
  profiles/
  runs/
    index.jsonl
    <run_id>/
      run.json
      events.jsonl
      profile.resolved.redacted.yaml
      linear-issue.json
      linear-issue.md
      linear-claim.md
      prompt.md
      codex.log
      codex.redacted.log
      codex-final.md
      validation.log
      validation.redacted.log
      diff-summary.json
      diff-summary.md
      pr-body.md
      pr-body.preview.md
      linear-handoff.md
      linear-failure.md
      linear-claim.preview.md
      artifacts.json
      result.md
      resume-attempts/
        001.json
  worktrees/<run_id>/
  locks/
  exports/
```

### File semantics

- `run.json`: current/final machine-readable state.
- `events.jsonl`: append-only event history.
- `result.md`: human-readable terminal summary.
- No separate `outcome.json` in v1.
- `artifacts.json`: manifest of generated files and intended visibility.
- `profile.resolved.redacted.yaml`: effective profile snapshot.
- `prompt.md`: canonical prompt used/generated.
- `codex.log`: raw local-only transcript.
- `codex.redacted.log`: redacted transcript for inspection/snippets.
- `diff-summary.*`: Symphony-verified diff summary.

### Atomic writes

For mutable JSON/Markdown state files:

```text
write temp file in same directory
fsync temp where practical
rename temp -> final path
fsync directory where practical
```

For `events.jsonl`:

- write one complete JSON line per event
- flush/fsync after important phase transitions

### `result.md`

Always write `result.md` for terminal states:

```text
succeeded
succeeded_with_warnings
failed
cancelled
refused
preflight_failed
dry_run
timed_out
```

Include:

- status/reason
- issue
- branch/worktree
- PR URL if any
- commits
- validation/CI summary
- Linear actions
- warnings
- recovery/next steps
- pointer to `artifacts.json`

---

## 9. Dry-run behavior

`run --dry-run` answers: “what would this run do right now?”

Allowed read-only activity:

- Linear eligible issue discovery
- Linear issue details/comments/attachment metadata
- GitHub branch protection / required checks reads
- local git inspection

Forbidden in dry-run:

- Linear status/assignee changes
- Linear comments
- branch/worktree creation
- Codex execution
- GitHub PR creation
- `git fetch`, `git pull`, or `git push` by default
- project validation commands

Dry-run still creates a local terminal run record with `status: dry_run` and `mutating: false`.

Dry-run artifacts:

```text
prompt.md                    # stamped DRY RUN — NOT EXECUTED
pr-body.preview.md            # stamped DRY RUN — NOT POSTED
linear-claim.preview.md       # stamped DRY RUN — NOT POSTED
artifacts.json
result.md
```

Dry-run is optional. It is not a prerequisite for real runs.

A future explicit `--refresh` may allow read-refresh behavior such as narrow fetch, but that is not default v1 behavior.

---

## 10. Preflight and claim

### Preflight before claim

Preflight is readiness-only. It does not run project tests.

Checks:

- profile schema valid
- `repo.path` exists, absolute, canonical, non-bare, normal Git checkout
- main checkout is clean
- main checkout is on configured base branch
- no merge/rebase/cherry-pick in progress
- configured remote/base is readable/fetchable
- local base equals `origin/base` after safe preflight fetch/fast-forward policy
- GitHub auth available
- Linear auth available
- Codex command available and non-interactive mode available
- optional Codex minimum version satisfied
- exactly one eligible issue exists unless `--issue` narrows to one eligible issue
- configured Linear statuses/assignee exist
- no conflicting repo lock exists
- deterministic target branch absent locally/remotely

### Claim flow

After preflight passes:

```text
re-fetch issue
verify still eligible
set status -> linear.claim_status
assign configured assignee
write linear-claim.md
post claim comment
re-fetch and verify claimed state
```

No branch, worktree, or Codex execution before claim verification passes.

If claim verification fails: `claim_verification_failed`.

Failures before claim stay local only. Failures after claim post a concise Linear failure comment.

Post-claim failures do not roll Linear back. The issue remains assigned and in `linear.claim_status`.

---

## 11. Branches, worktrees, and locks

Rules:

- one active run per canonical repo path in v1
- per-repo lock under `~/.symphony/locks/`
- lock file records `lock_id`, `run_id`, `repo_path`, `pid`, `hostname`, `created_at`, and command
- PID liveness is informational only; no auto-unlock
- manual unlock requires `--reason`
- prefer `runs cancel` for active runs

Worktree/branch flow:

```text
claim verified
create deterministic branch from verified base
create per-run worktree at ~/.symphony/worktrees/<run_id>/
run Codex from worktree root only
```

Branch format:

```text
symphony/<profile>/<issue-key>-<slug>
```

Refuse if branch exists locally or remotely.

---

## 12. Adapter and command runner boundaries

Integrations live behind adapters:

```text
GitClient
GitHubClient
LinearClient
CodexRunner
```

v1 may use CLIs pragmatically:

- `git` for repository/worktree operations
- `gh` for GitHub PRs/checks/branch protection
- `codex` for implementation attempts
- Linear direct GraphQL behind `LinearClient` if no reliable CLI exists

All subprocess calls go through one command runner/logger.

Command runner responsibilities:

- execute argv arrays by default
- allow explicit shell mode only where configured
- set cwd/env/timeout policy
- capture stdout/stderr
- redact before logging
- normalize exit codes
- emit command/side-effect events
- register log artifacts

Validation commands also use this runner.

---

## 13. Prompt and Codex execution

Codex v1 rules:

- `agent.kind: codex` only
- non-interactive/exec mode only
- model pinned when configured
- optional `agent.min_version` enforced when configured
- run with explicit cwd = per-run worktree root
- invoke `codex exec --json --sandbox danger-full-access -` so Codex can write Git metadata and create its own commit; the safety boundary is the isolated disposable worktree plus Symphony's post-Codex gates, not Codex's `workspace-write` sandbox
- never run from main checkout
- never run from run-record directory
- no implicit cwd inheritance
- no access to run-record directory path
- prompt passed via stdin or controlled temporary copy, not via `~/.symphony/runs/<run_id>/prompt.md` argument

Prompt includes:

- Linear issue key/title/body/comments within caps
- repo/base/branch context
- Symphony workflow contract
- fixed “do not do” section
- deterministic root instruction files if present:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursorrules`
  - `CONTRIBUTING.md`
- static `prompt.extra_instructions`

Codex must not:

- create/push branches
- open PRs
- post GitHub/Linear comments
- move statuses
- include secrets in code/logs/summaries
- modify files outside the worktree
- leave uncommitted changes
- claim success without commits

Codex should end with structured advisory output:

```text
SUMMARY:
- ...

FILES_CHANGED:
- path: reason

VALIDATION_RUN:
- command: result

RISKS:
- ...
```

Symphony stores this as `codex-final.md`, but verifies actual commits/diff/validation independently. Missing/malformed final output records warning `codex_final_unstructured`, not a default failure.

---

## 14. Commits and changed-file policy

Codex must create at least one commit.

Symphony does not auto-commit.

Failures:

- no new commits -> `no_commit`
- dirty worktree after Codex -> `dirty_worktree_after_codex`
- dirty worktree after validation -> `dirty_worktree_after_validation`

Commit policy:

- each new commit must include issue key in subject or footer
- failure reason: `commit_message_policy_failed`
- do not auto-amend/rewrite/squash in v1

Authorship:

- always record author/committer name/email locally
- do not publish email addresses by default
- enforcement is profile-configurable
- default Git identity comes from local/repo config
- optional explicit profile identity is opt-in

Changed-file checks before validation/push/PR:

- all changed paths resolve inside worktree
- no symlink/path escape weirdness
- no forbidden paths
- no likely secrets
- no huge files over configured limit
- no binary files unless allowed
- if `change_policy.allowed_paths` is present, every changed path must match it

Failure: `change_policy_failed`.

---

## 15. Validation and CI

Validation is profile-defined and runs after Codex commits and changed-file checks.

Rules:

- validation commands use centralized runner
- prefer `argv`
- explicit `shell` allowed only when configured
- no untrusted issue text interpolation into shell
- validation logs captured/redacted
- if no validation configured, handoff says `validation: not_configured`
- worktree must remain clean after validation
- no Symphony-specific ignore list for validation dirtiness

No remote push until local gates pass:

```text
Codex commits
-> changed-file safety checks
-> local validation
-> post-validation clean check
-> final narrow base fetch/base-moved check
-> push branch
-> create PR
-> wait CI
```

Before push, perform narrow final fetch:

```bash
git fetch <remote> <base_branch>
```

No pull/merge/rebase.

Failures:

- fetch failed -> `final_fetch_failed`
- base moved -> `base_moved_during_run`

No v1 override for base movement.

Required remote CI is part of success.

- read required checks from GitHub branch protection when possible
- if unreadable/unconfigured, require explicit profile fallback list
- do not guess from observed checks
- no automatic CI reruns in v1
- CI failure -> `ci_failed`
- CI timeout -> `ci_timeout`

---

## 16. PR and Linear handoff

PR rules:

- create non-draft PRs
- deterministic title: `<ISSUE-KEY>: <sanitized Linear title>`
- generate `pr-body.md` before PR creation and use that exact file
- include visible delimited Symphony status block
- include hidden non-secret metadata block
- no local absolute paths in GitHub-visible content
- PR comments are not posted by default
- PR body status block is updated after CI

PR body markers:

```md
<!-- symphony:status:start -->
...
<!-- symphony:status:end -->

<!-- symphony:metadata
run_id: ...
profile: ...
linear_issue: MS-123
-->
```

GitHub decorations:

- labels are best-effort when configured
- missing labels are not auto-created
- reviewers are explicit + best-effort
- assignees are explicit + best-effort
- no milestones
- no GitHub Projects
- no auto-merge

Linear handoff:

```text
claim issue -> linear.claim_status
PR created -> stay in claim_status
required CI green -> move to linear.success_status + post handoff
CI failed/timed out -> stay in claim_status + post failure comment
```

Native Linear PR link is best-effort after PR creation. Failure warning: `linear_pr_link_failed`.

Post-claim failure comments include:

- status/reason
- short explanation
- local run path for recovery
- PR URL if any
- commit/branch info if any
- no full transcript
- optional short redacted tail only if safe

If CI green but Linear handoff fails, mark `succeeded_with_warnings` with warning `linear_handoff_failed` and write recovery instructions.

---

## 17. Redaction and public content limits

Before publishing to GitHub or Linear, run a redaction/safety scan.

Block on likely secrets:

```text
api_key
token
secret
password
Authorization:
Bearer 
AWS_ACCESS_KEY
.env
private key material
```

GitHub-visible content must also block local absolute paths:

```text
/Users/...
~/.symphony/runs/...
```

Linear comments may intentionally include local run paths for recovery, but never secrets.

Default public size caps:

```yaml
github.pr_body_max_chars: 12000
linear.comment_max_chars: 8000
linear.output_tail_max_lines: 80
```

Preserve required metadata while truncating verbose sections first.

---

## 18. Cleanup and recovery

Success cleanup:

- delete local branch/worktree if configured
- keep remote branch
- keep run record
- do not delete remote branch

Failure/warning cleanup:

- keep local branch/worktree
- keep run record
- no automatic rollback

`runs cleanup`:

- preview-only by default
- `--apply` required for deletion
- supports filters like `--older-than` and `--status`
- never delete active/locked runs
- never delete runs with open PRs unless a future explicit flag exists
- failed worktree cleanup only when clean, inactive, old enough, safely recoverable, no unpushed commits, no open PR

`runs resume`:

- only post-implementation recovery/handoff
- does not rerun Codex
- does not rerun failed validation
- does not mutate commits
- requires internal `runs verify`
- no `--force-resume`
- writes `resume-attempts/<n>.json`
- appends to same `events.jsonl`
- keeps same `run_id`

Allowed resume cases:

- PR was created but Linear handoff failed
- PR was created and CI timed out; re-check CI
- branch was pushed but PR creation failed; retry PR creation
- best-effort label/reviewer/assignee/status update failed

`runs cancel`:

- stop Codex if running
- release lock
- mark `cancelled/manual_cancelled`
- preserve branch/worktree/run record
- post Linear cancellation comment if claimed
- claimed cancellation requires `--reason`
- no automatic unassign
- no status rollback
- no PR close/delete

---

## 19. Run inspection and export

`runs list` uses `~/.symphony/runs/index.jsonl` as a rebuildable cache.

`runs rebuild-index`:

- backs up existing index
- scans `~/.symphony/runs/*/run.json`
- skips but reports corrupt records
- no repo/GitHub/Linear mutation

`runs verify <run_id>`:

- parse `run.json`
- parse every `events.jsonl` line
- verify `artifacts.json` entries exist
- verify terminal states have `result.md`
- check required artifacts for current phase/status
- support `--json`
- no mutation

`runs export <run_id>`:

- writes `~/.symphony/exports/<run_id>.tar.gz`
- includes run metadata and redacted logs
- includes `EXPORT-MANIFEST.json`
- excludes raw logs, worktree, secrets, local-sensitive env
- no `--include-raw-logs` in v1
- export means redacted/shareable

---

## 20. Exit codes

Stable coarse CLI exit codes:

```text
0  succeeded
1  general failure
2  refused / not eligible / no-op
3  preflight failed
4  Codex failed or timed out
5  validation failed
6  PR/handoff failed
7  CI failed or timed out
8  cancelled
9  configuration/schema error
10 lock exists
```

Detailed status/reason lives in JSON output.

---

## 21. Implementation slices

### Slice 1: Profile + storage foundation

- schema parser/validator
- `profiles init/list/show/validate`
- run id generation
- run directory creation
- atomic writes
- `run.json`, `events.jsonl`, `artifacts.json`
- central transition function/table
- `runs show/list/rebuild-index/verify`

### Slice 2: Dry-run

- read-only Linear/GitHub adapters
- candidate discovery
- issue snapshot artifacts
- prompt generation
- preview PR/Linear artifacts
- dry-run `result.md`
- `--json` outputs

### Slice 3: Real claim + worktree + Codex

- preflight
- locks
- Linear claim transaction
- worktree/branch creation
- Codex non-interactive runner
- transcript capture/redaction
- commit detection and authorship recording

### Slice 4: Local gates + PR

- changed-file policy
- commit message policy
- validation runner
- post-validation clean check
- final narrow fetch/base moved check
- push branch
- create PR
- PR body status block

### Slice 5: CI + Linear handoff

- required-check discovery/fallback
- CI polling/timeouts
- Linear success/failure/handoff comments
- best-effort native PR linking
- warnings and `succeeded_with_warnings`

### Slice 6: Operations hardening

- resume
- cancel
- cleanup
- export
- lock commands
- redaction edge cases
- end-to-end tests

---

## 22. Key test targets

- invalid profile schema fails with stable reason
- relative repo path fails
- bare repo fails
- zero/multiple candidates refuse
- manual `--issue` cannot bypass eligibility
- no branch/worktree before claim verification
- post-claim pre-push failure posts Linear failure comment
- Codex no-commit fails
- dirty after Codex fails
- dirty after validation fails
- change-policy violation fails before validation/push
- base moved during run fails before push
- branch pushed only after local gates pass
- required CI failure leaves issue in claim status
- CI green moves to success status and posts handoff
- Linear handoff failure after CI green becomes warning state
- invalid state transitions are impossible
- `events.jsonl` schema is valid
- `runs verify` catches missing artifacts/result
- `runs export` excludes raw logs

---

## 23. Open defaults to carry into implementation

These are decided defaults unless revisited explicitly:

- `repo.path` must be a normal non-bare checkout.
- `profiles doctor` does not discover candidate issues; dry-run does.
- `run --dry-run` does not fetch by default.
- no profile inheritance.
- no env interpolation.
- no remote branch cleanup.
- no auto-merge/release/deploy.
- no GitHub PR comments by default.
- no raw-log export flag.

---

## 24. Minimal successful run definition

A Symphony v1 run is successful only when all of these are true:

```text
one eligible issue was claimed
Codex produced at least one compliant commit
worktree was clean after Codex
changed-file policy passed
profile validation passed
worktree was clean after validation
base did not move during the run
branch was pushed
non-draft PR was created
required GitHub CI passed
Linear issue was moved to success_status
Linear handoff comment was posted
terminal result.md was written
run record/index were updated
```

If CI passes but Linear handoff fails, the implementation may be valid but the run is only `succeeded_with_warnings`, not plain `succeeded`.
