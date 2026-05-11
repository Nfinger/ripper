# Symphony Supervised Profile v1 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Implement the supervised one-ticket Codex runner described in `docs/supervised-profile-v1-spec.md` without destabilizing the existing daemon/WORKFLOW.md mode.

**Architecture:** Add a new supervised command surface alongside the existing daemon path. Keep v1 logic in new `src/supervised/*` modules: schema, run records, state machine, command runner, adapters, dry-run, and real-run pipeline. Reuse existing Linear/Codex concepts only where they fit cleanly; do not mutate the legacy daemon around the new safety model.

**Tech Stack:** TypeScript ESM, Node >=20, Vitest, `js-yaml`, existing `git`/`gh`/`codex` CLIs, Linear GraphQL via `fetch`.

---

## Current repo reality

Verified files:

- `package.json` has `build`, `typecheck`, and `test` scripts.
- `src/index.ts` currently implements the legacy daemon CLI: `symphony [WORKFLOW.md] [--config-dir] [--dry-run]`.
- Existing workflow config is Markdown front matter in `src/workflow/*`.
- Existing Codex/Claude runner lives at `src/agent/runner.ts` and currently invokes shell commands via `bash -lc`.
- Existing Linear adapter lives at `src/tracker/linear.ts`; it can fetch candidates and post comments/attachments, but supervised v1 needs more Linear mutations/status/assignee/link operations.
- Supervised spec is saved at `docs/supervised-profile-v1-spec.md`.
- `/Users/homebase/ai/symphony` was not a git repository when checked, so commit steps below are logical checkpoints, not guaranteed executable until the project is placed under git.

## Implementation approach

Do this in slices. After every slice:

```bash
pnpm typecheck
pnpm test
pnpm build
```

If no git repo is present, skip commit commands and record the checkpoint in `result.md`/notes. If a git repo exists later, commit after each task group.

---

## Slice 1: CLI routing and supervised module skeleton

### Task 1: Add top-level CLI command router

**Objective:** Preserve legacy daemon behavior while adding explicit supervised subcommands.

**Files:**
- Modify: `src/index.ts`
- Create: `src/cli/types.ts`
- Create: `src/cli/router.ts`
- Test: `tests/cli-router.test.ts`

**Step 1: Write failing tests**

Create `tests/cli-router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseTopLevelArgs } from '../src/cli/router.js';

describe('parseTopLevelArgs', () => {
  it('routes legacy args to daemon mode', () => {
    expect(parseTopLevelArgs(['clients/market-savvy.WORKFLOW.md'])).toEqual({
      mode: 'legacy',
      argv: ['clients/market-savvy.WORKFLOW.md'],
      noInteractive: false,
    });
  });

  it('routes supervised run command', () => {
    expect(parseTopLevelArgs(['run', 'marketsavvy-codex', '--dry-run'])).toEqual({
      mode: 'supervised',
      command: 'run',
      argv: ['marketsavvy-codex', '--dry-run'],
      noInteractive: false,
    });
  });

  it('supports global --no-interactive before command', () => {
    expect(parseTopLevelArgs(['--no-interactive', 'run', 'p'])).toEqual({
      mode: 'supervised',
      command: 'run',
      argv: ['p'],
      noInteractive: true,
    });
  });
});
```

**Step 2: Run failing test**

```bash
pnpm vitest run tests/cli-router.test.ts
```

Expected: fails because `src/cli/router.ts` does not exist.

**Step 3: Implement router**

Create `src/cli/types.ts`:

```ts
export type SupervisedCommand = 'run' | 'profiles' | 'runs' | 'locks';

export type TopLevelArgs =
  | { mode: 'legacy'; argv: string[]; noInteractive: boolean }
  | { mode: 'supervised'; command: SupervisedCommand; argv: string[]; noInteractive: boolean };
```

Create `src/cli/router.ts`:

```ts
import type { SupervisedCommand, TopLevelArgs } from './types.js';

const SUPERVISED = new Set<SupervisedCommand>(['run', 'profiles', 'runs', 'locks']);

export function parseTopLevelArgs(argv: string[]): TopLevelArgs {
  const args = [...argv];
  let noInteractive = false;
  if (args[0] === '--no-interactive') {
    noInteractive = true;
    args.shift();
  }
  const first = args[0];
  if (first && SUPERVISED.has(first as SupervisedCommand)) {
    args.shift();
    return { mode: 'supervised', command: first as SupervisedCommand, argv: args, noInteractive };
  }
  return { mode: 'legacy', argv: args, noInteractive };
}
```

**Step 4: Wire `src/index.ts` minimally**

Refactor current `main()` body into `runLegacyDaemon(argv: string[]): Promise<void>` and call it when router mode is `legacy`.

For supervised mode, initially print a clear not-implemented error and exit `9`:

```ts
if (top.mode === 'supervised') {
  process.stderr.write(`symphony ${top.command}: not implemented yet\n`);
  process.exit(9);
}
```

**Step 5: Verify**

```bash
pnpm vitest run tests/cli-router.test.ts
pnpm typecheck
```

Expected: tests and typecheck pass.

---

### Task 2: Add supervised command dispatcher skeleton

**Objective:** Create one entry point for supervised commands with stable exit-code plumbing.

**Files:**
- Create: `src/supervised/exit-codes.ts`
- Create: `src/supervised/command.ts`
- Modify: `src/index.ts`
- Test: `tests/supervised-command.test.ts`

**Step 1: Test command skeleton**

Create `tests/supervised-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dispatchSupervisedCommand } from '../src/supervised/command.js';
import { EXIT_CONFIG_OR_SCHEMA } from '../src/supervised/exit-codes.js';

describe('dispatchSupervisedCommand', () => {
  it('returns schema/config exit for unknown profiles subcommand', async () => {
    const result = await dispatchSupervisedCommand({
      command: 'profiles',
      argv: ['bogus'],
      noInteractive: true,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(result.exitCode).toBe(EXIT_CONFIG_OR_SCHEMA);
  });
});
```

**Step 2: Implement constants**

Create `src/supervised/exit-codes.ts`:

```ts
export const EXIT_SUCCEEDED = 0;
export const EXIT_GENERAL_FAILURE = 1;
export const EXIT_REFUSED = 2;
export const EXIT_PREFLIGHT_FAILED = 3;
export const EXIT_CODEX_FAILED = 4;
export const EXIT_VALIDATION_FAILED = 5;
export const EXIT_HANDOFF_FAILED = 6;
export const EXIT_CI_FAILED = 7;
export const EXIT_CANCELLED = 8;
export const EXIT_CONFIG_OR_SCHEMA = 9;
export const EXIT_LOCK_EXISTS = 10;
```

Create dispatcher with a small typed result:

```ts
import type { SupervisedCommand } from '../cli/types.js';
import { EXIT_CONFIG_OR_SCHEMA } from './exit-codes.js';

export interface DispatchOptions {
  command: SupervisedCommand;
  argv: string[];
  noInteractive: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface DispatchResult {
  exitCode: number;
}

export async function dispatchSupervisedCommand(opts: DispatchOptions): Promise<DispatchResult> {
  opts.stderr(`symphony ${opts.command}: not implemented yet\n`);
  return { exitCode: EXIT_CONFIG_OR_SCHEMA };
}
```

**Step 3: Wire index**

Replace the temporary not-implemented block with a call to `dispatchSupervisedCommand(...)`.

**Step 4: Verify**

```bash
pnpm vitest run tests/supervised-command.test.ts tests/cli-router.test.ts
pnpm typecheck
```

---

## Slice 2: Profile schema and profile CLI

### Task 3: Define supervised profile types

**Objective:** Create the v1 profile type model matching the spec.

**Files:**
- Create: `src/supervised/profile/types.ts`
- Test: `tests/supervised-profile-types.test.ts`

**Step 1: Add compile-time smoke test**

Create a test that imports types and builds a minimal object.

```ts
import { describe, expect, it } from 'vitest';
import type { SupervisedProfile } from '../src/supervised/profile/types.js';

describe('SupervisedProfile type', () => {
  it('accepts a minimal v1 profile shape', () => {
    const profile: SupervisedProfile = {
      schema_version: 1,
      name: 'p',
      repo: { path: '/tmp/repo', remote: 'origin', base_branch: 'main' },
      linear: {
        team: 'ENG',
        eligible_status: 'Todo',
        claim_status: 'In Progress',
        success_status: 'Ready for Review',
        failure_status: null,
        require_unassigned: true,
        required_labels: [],
        assignee: { mode: 'authenticated_user' },
      },
      agent: { kind: 'codex', command: 'codex', model: 'gpt-5.5', timeout_minutes: 60 },
      prompt: { include_repo_instruction_files: [], repo_instruction_max_chars: 20000, extra_instructions: null },
      validation: { network: 'allowed', commands: [] },
      change_policy: { allowed_paths: null, forbidden_paths: [], max_file_bytes: 1000000, allow_binary_files: false },
      github: { create_pr: true, draft: false, require_ci_green_before_success: true, ci_timeout_minutes: 30, ci_poll_interval_seconds: 30, required_checks: { mode: 'github_required_checks', fallback: [] }, labels: { best_effort: true, create_missing: false, names: [] }, reviewers: { users: [], teams: [], best_effort: true }, assignees: { users: [], best_effort: true }, pr_body_max_chars: 12000 },
      run: { max_total_minutes: 100 },
      cleanup: { delete_local_branch_on_success: true, delete_local_worktree_on_success: true, delete_remote_branch_on_success: false, delete_run_record_on_success: false, keep_local_branch_on_failure: true, keep_local_branch_on_warning: true },
    };
    expect(profile.agent.kind).toBe('codex');
  });
});
```

**Step 2: Implement types**

Create `src/supervised/profile/types.ts` with explicit interfaces. Keep fields optional only when the schema truly defaults them.

**Step 3: Verify**

```bash
pnpm vitest run tests/supervised-profile-types.test.ts
pnpm typecheck
```

---

### Task 4: Add YAML profile loader and schema validator

**Objective:** Load `~/.symphony/profiles/<profile>.yaml`, reject missing/unsupported schema versions, reject unknown agent kinds, and apply defaults.

**Files:**
- Create: `src/supervised/profile/loader.ts`
- Create: `src/supervised/profile/errors.ts`
- Test: `tests/supervised-profile-loader.test.ts`

**Step 1: Write tests**

Cover:

- valid profile loads
- missing `schema_version` fails with `profile_schema_version_missing`
- unsupported `schema_version` fails
- `agent.kind: claude` fails in supervised v1
- `repo.path` relative fails with `repo_path_not_absolute`
- unknown top-level key fails

**Step 2: Implement loader**

Use `js-yaml` and existing project ESM style.

Expose:

```ts
export type ProfileLoadResult =
  | { ok: true; profile: SupervisedProfile; sourcePath: string; resolvedHash: string }
  | { ok: false; error: SupervisedProfileError };

export function profilePath(profileName: string, homeDir = os.homedir()): string;
export function loadSupervisedProfile(profileName: string, opts?: { homeDir?: string }): ProfileLoadResult;
```

Hash the canonical redacted/resolved profile JSON with SHA-256.

**Step 3: Verify**

```bash
pnpm vitest run tests/supervised-profile-loader.test.ts
pnpm typecheck
```

---

### Task 5: Implement `profiles validate/list/show/init`

**Objective:** Provide non-mutating profile management commands.

**Files:**
- Create: `src/supervised/commands/profiles.ts`
- Modify: `src/supervised/command.ts`
- Test: `tests/supervised-profiles-command.test.ts`

**Tests:**

- `profiles init <name>` creates `~/.symphony/profiles/<name>.yaml` and refuses overwrite
- `profiles init <name> --repo <path>` writes canonical absolute repo path
- `profiles validate <name>` returns 0 for valid profile
- `profiles show <name>` prints redacted profile
- `profiles list` lists `*.yaml`
- `--json` emits stable non-secret JSON

**Implementation notes:**

Inject `homeDir`, `stdout`, and `stderr` for tests. Do not call Linear/GitHub/Codex in these commands.

---

## Slice 3: Run records, events, and state machine

### Task 6: Implement atomic file writer

**Objective:** Provide safe writes for run state/artifacts.

**Files:**
- Create: `src/supervised/storage/atomic.ts`
- Test: `tests/supervised-atomic.test.ts`

**Test cases:**

- writes JSON atomically
- overwrites existing file with valid JSON
- temp file is in same directory

Expose:

```ts
export async function writeFileAtomic(path: string, content: string): Promise<void>;
export async function writeJsonAtomic(path: string, value: unknown): Promise<void>;
```

---

### Task 7: Implement run record layout

**Objective:** Create and update durable local run directories.

**Files:**
- Create: `src/supervised/run-record/types.ts`
- Create: `src/supervised/run-record/store.ts`
- Test: `tests/supervised-run-record.test.ts`

**Expose:**

```ts
export function generateRunId(issueKey: string | null, now: Date): string;
export async function createRunRecord(opts: CreateRunRecordOptions): Promise<RunRecord>;
export async function updateRunJson(runDir: string, run: RunRecord): Promise<void>;
export async function appendEvent(runDir: string, event: RunEvent): Promise<void>;
```

**Tests:**

- run id is deterministic enough: UTC timestamp + issue key when present
- creates `run.json`, `events.jsonl`, `artifacts.json`
- appends complete event lines
- terminal `result.md` is required by verify later

---

### Task 8: Implement state transition table

**Objective:** Centralize legal run transitions.

**Files:**
- Create: `src/supervised/run-record/state-machine.ts`
- Test: `tests/supervised-state-machine.test.ts`

**Tests:**

- `initialized -> preflight_running` allowed
- `claimed -> codex_running` allowed
- `preflight_failed -> handoff_running` rejected
- transition writes event and updates `run.json`

**Implementation:**

```ts
export function assertTransitionAllowed(from: RunStatus, to: RunStatus): void;
export async function transitionRun(store: RunStore, runId: string, to: RunStatus, reason?: RunReason): Promise<void>;
```

---

### Task 9: Implement `runs show/list/rebuild-index/verify`

**Objective:** Make local inspection useful before external integrations exist.

**Files:**
- Create: `src/supervised/commands/runs.ts`
- Modify: `src/supervised/command.ts`
- Test: `tests/supervised-runs-command.test.ts`

**Tests:**

- `runs show <run_id>` reads `run.json`
- `runs list` uses `index.jsonl`
- `runs rebuild-index` scans run directories and backs up old index
- `runs verify <run_id>` catches missing `result.md` for terminal states
- `--json` output is stable

---

## Slice 4: Command runner, redaction, and git adapter

### Task 10: Implement redaction utility

**Objective:** Centralize safe output handling.

**Files:**
- Create: `src/supervised/safety/redaction.ts`
- Test: `tests/supervised-redaction.test.ts`

**Tests:**

- redacts `Authorization: Bearer ...`
- redacts `token=...`
- redacts obvious private key blocks
- flags `/Users/...` as unsafe for GitHub-visible content
- allows local paths in Linear when explicitly configured

Expose both transform and scan:

```ts
export function redactText(input: string): string;
export function scanPublicContent(input: string, opts: { surface: 'github' | 'linear' }): SafetyScanResult;
```

---

### Task 11: Implement central command runner

**Objective:** Run subprocesses with argv by default, controlled shell mode only when explicit.

**Files:**
- Create: `src/supervised/command-runner/types.ts`
- Create: `src/supervised/command-runner/runner.ts`
- Test: `tests/supervised-command-runner.test.ts`

**Tests:**

- executes argv command with cwd
- captures stdout/stderr
- times out and kills process
- redacts logs before writing redacted artifact
- shell commands require `mode: 'shell'`
- emits side-effect/command events through injected recorder

---

### Task 12: Implement Git adapter

**Objective:** Wrap all git operations needed before Linear/GitHub integration.

**Files:**
- Create: `src/supervised/adapters/git.ts`
- Test: `tests/supervised-git-adapter.test.ts`

**Methods:**

```ts
isWorktree(path): Promise<boolean>
isBareRepo(path): Promise<boolean>
currentBranch(path): Promise<string>
statusPorcelain(path): Promise<string>
remoteBaseSha(path, remote, base): Promise<string>
fetchBase(path, remote, base): Promise<void>
branchExists(path, branch): Promise<boolean>
remoteBranchExists(path, remote, branch): Promise<boolean>
createWorktree(repoPath, worktreePath, branch, baseRef): Promise<void>
newCommits(baseSha, headRef): Promise<CommitInfo[]>
changedFiles(baseSha, headRef): Promise<ChangedFile[]>
pushBranch(worktreePath, remote, branch): Promise<void>
```

Use temporary local git repos in tests.

---

## Slice 5: Dry-run pipeline

### Task 13: Implement supervised Linear adapter read methods

**Objective:** Read exactly the data needed for eligibility/dry-run.

**Files:**
- Create: `src/supervised/adapters/linear.ts`
- Test: `tests/supervised-linear-adapter.test.ts`

**Read methods:**

```ts
findEligibleIssues(profile): Promise<LinearIssue[]>
getIssueByKey(key): Promise<LinearIssue | null>
verifyStatuses(profile): Promise<StatusVerification>
verifyAssignee(profile): Promise<AssigneeVerification>
```

Use fetch mocks; do not use real credentials in tests.

---

### Task 14: Implement prompt builder

**Objective:** Generate canonical `prompt.md` for dry-run and real runs.

**Files:**
- Create: `src/supervised/prompt/build.ts`
- Test: `tests/supervised-prompt.test.ts`

**Tests:**

- includes issue title/body/comments within caps
- includes fixed “do not do” section
- includes root `AGENTS.md` when present
- excludes `README.md` by default
- applies total instruction cap with truncation marker
- includes static `prompt.extra_instructions`
- never includes run record absolute path

---

### Task 15: Implement `run --dry-run`

**Objective:** Create a full non-mutating run record and preview artifacts.

**Files:**
- Create: `src/supervised/run/dry-run.ts`
- Modify: `src/supervised/commands/run.ts`
- Modify: `src/supervised/command.ts`
- Test: `tests/supervised-dry-run.test.ts`

**Behavior:**

- load/validate profile
- create local run record with `mutating: false`
- find exactly one eligible issue or refuse
- write `linear-issue.json`, `linear-issue.md`
- generate `prompt.md` stamped `DRY RUN — NOT EXECUTED`
- generate `pr-body.preview.md` and `linear-claim.preview.md`
- write `result.md`
- no branch/worktree/GitHub/Linear mutation

---

## Slice 6: Real run through Codex/local validation

### Task 16: Implement locks

**Objective:** Prevent concurrent runs per canonical repo path.

**Files:**
- Create: `src/supervised/locks/store.ts`
- Create: `src/supervised/commands/locks.ts`
- Test: `tests/supervised-locks.test.ts`

**Tests:**

- acquire lock writes lock file
- second acquire fails with `lock_exists`
- liveness is informational only
- manual unlock requires reason and writes audit event when tied to run

---

### Task 17: Implement preflight

**Objective:** Enforce readiness before claim.

**Files:**
- Create: `src/supervised/run/preflight.ts`
- Test: `tests/supervised-preflight.test.ts`

**Checks:**

- profile schema
- absolute canonical non-bare repo
- clean main checkout
- on base branch
- no merge/rebase in progress
- base fetchable
- target branch absent local/remote
- GitHub auth readable
- Linear auth/status/assignee readable
- Codex available, non-interactive, min version if configured

---

### Task 18: Implement claim flow

**Objective:** Claim one issue after preflight, with verification.

**Files:**
- Extend: `src/supervised/adapters/linear.ts`
- Create: `src/supervised/run/claim.ts`
- Test: `tests/supervised-claim.test.ts`

**Mutations:**

- set status to `linear.claim_status`
- assign configured assignee
- post claim comment
- re-fetch issue and verify status/assignee

Failure after claim posts Linear failure comments later; failure before claim remains local.

---

### Task 19: Implement worktree creation and Codex runner

**Objective:** Create per-run worktree and run Codex non-interactively.

**Files:**
- Create: `src/supervised/adapters/codex.ts`
- Create: `src/supervised/run/codex-phase.ts`
- Test: `tests/supervised-codex-phase.test.ts`

**Rules:**

- Codex cwd = `~/.symphony/worktrees/<run_id>`
- invoke Codex as `codex exec --json --sandbox danger-full-access -`; real smoke tests showed `workspace-write` can edit files but cannot create `.git/index.lock`, so it cannot satisfy the v1 requirement that Codex creates commits
- canonical prompt stored in run record
- prompt passed through stdin or controlled temp copy
- no run-record path in prompt/args
- capture `codex.log` and `codex.redacted.log`
- store `codex-final.md`
- timeout maps to `codex_timeout`
- missing non-interactive support maps to `codex_noninteractive_unavailable`

---

### Task 20: Implement commit/diff/change-policy checks

**Objective:** Verify Codex output before validation.

**Files:**
- Create: `src/supervised/run/commit-checks.ts`
- Create: `src/supervised/run/change-policy.ts`
- Test: `tests/supervised-change-policy.test.ts`

**Checks:**

- at least one new commit or `no_commit`
- clean worktree or `dirty_worktree_after_codex`
- commit message contains issue key or `commit_message_policy_failed`
- record author/committer locally
- changed files inside worktree
- forbidden paths/secrets/binary/size/allowlist checks
- write `diff-summary.json` and `diff-summary.md`

---

### Task 21: Implement validation phase

**Objective:** Run profile validation commands and enforce clean tree after validation.

**Files:**
- Create: `src/supervised/run/validation.ts`
- Test: `tests/supervised-validation.test.ts`

**Rules:**

- validation commands use central runner
- `argv` preferred
- `shell` only when configured
- write validation raw/redacted logs
- fail `validation_failed` on nonzero command
- fail `dirty_worktree_after_validation` if git status is non-empty afterward

---

## Slice 7: GitHub PR, CI, and Linear handoff

### Task 22: Implement GitHub adapter

**Objective:** Wrap `gh` CLI operations through central runner.

**Files:**
- Create: `src/supervised/adapters/github.ts`
- Test: `tests/supervised-github-adapter.test.ts`

**Methods:**

```ts
checkAuth(): Promise<Result>
readRequiredChecks(repoPath, baseBranch): Promise<RequiredChecksResult>
createPr(opts): Promise<PrInfo>
updatePrBody(prUrl, body): Promise<void>
requestReviewers(opts): Promise<Warning[]>
assignUsers(opts): Promise<Warning[]>
applyLabels(opts): Promise<Warning[]>
getChecks(pr): Promise<CheckStatus[]>
```

No PR comments by default.

---

### Task 23: Implement final fetch, push, and PR creation

**Objective:** Publish only after all local gates pass.

**Files:**
- Create: `src/supervised/run/publish.ts`
- Test: `tests/supervised-publish.test.ts`

**Behavior:**

- narrow final fetch `git fetch <remote> <base_branch>`
- compare base SHA to run-start SHA
- fail `final_fetch_failed` or `base_moved_during_run`
- push branch
- create non-draft PR
- apply best-effort labels/reviewers/assignees
- update PR body status block as needed

---

### Task 24: Implement CI wait

**Objective:** Require configured/branch-protection CI to pass before success.

**Files:**
- Create: `src/supervised/run/ci.ts`
- Test: `tests/supervised-ci.test.ts`

**Tests:**

- all required checks pass -> success
- any required check fails -> `ci_failed`
- timeout -> `ci_timeout`
- branch protection unavailable and no fallback -> preflight/profile error
- no automatic reruns

---

### Task 25: Implement Linear handoff/failure/cancel comments

**Objective:** Complete workflow notification semantics.

**Files:**
- Extend: `src/supervised/adapters/linear.ts`
- Create: `src/supervised/run/handoff.ts`
- Test: `tests/supervised-handoff.test.ts`

**Behavior:**

- after CI green, move to `linear.success_status`
- post handoff comment
- add native PR link best-effort, warning `linear_pr_link_failed`
- on post-claim failure, post failure comment and leave status as claim status
- cancellation leaves assigned/In Progress and posts cancellation comment

---

## Slice 8: Recovery, cleanup, export

### Task 26: Implement resume

**Objective:** Retry safe post-implementation handoff steps only.

**Files:**
- Create: `src/supervised/run/resume.ts`
- Test: `tests/supervised-resume.test.ts`

**Rules:**

- internally run `runs verify`
- fail `resume_integrity_check_failed` before mutation if invalid
- no `--force-resume`
- no rerun Codex
- no rerun failed validation
- no commit mutation
- append `resume-attempts/<n>.json`

---

### Task 27: Implement cancel

**Objective:** Conservative manual cancellation.

**Files:**
- Create: `src/supervised/run/cancel.ts`
- Test: `tests/supervised-cancel.test.ts`

**Rules:**

- required `--reason` after claim
- stop Codex if running
- release lock
- preserve worktree/branch/run record
- post Linear cancellation comment if claimed
- no unassign/status rollback/PR close

---

### Task 28: Implement cleanup

**Objective:** Preview/apply local cleanup safely.

**Files:**
- Create: `src/supervised/run/cleanup.ts`
- Test: `tests/supervised-cleanup.test.ts`

**Rules:**

- preview by default
- `--apply` required
- never delete active/locked runs
- never delete open-PR runs in v1
- failed worktree cleanup requires `--include-worktrees --apply` and clean/inactive/no-unpushed/no-open-PR checks
- no remote branch deletion

---

### Task 29: Implement redacted export

**Objective:** Produce shareable run bundles.

**Files:**
- Create: `src/supervised/run/export.ts`
- Test: `tests/supervised-export.test.ts`

**Rules:**

- output `~/.symphony/exports/<run_id>.tar.gz`
- include `run.json`, `events.jsonl`, `result.md`, `artifacts.json`, redacted logs, `EXPORT-MANIFEST.json`
- exclude raw logs/worktree/env/secrets
- no raw-log export flag in v1

Use Node archive implementation or add a small dependency only if necessary and justified.

---

## Slice 9: End-to-end command integration

### Task 30: Wire `symphony run <profile>` real pipeline

**Objective:** Compose the phase modules into one deterministic command.

**Files:**
- Create/complete: `src/supervised/commands/run.ts`
- Modify: `src/supervised/command.ts`
- Test: `tests/supervised-run-pipeline.test.ts`

**Pipeline:**

```text
load profile
create run record
acquire lock
find exactly one eligible issue
preflight
claim + verify
create branch/worktree
build prompt
run Codex
commit/diff/change-policy checks
validation
final fetch/base check
push
PR
CI
Linear handoff
success cleanup
result.md
release lock
```

Test with mocked adapters; do not hit real Linear/GitHub/Codex.

---

### Task 31: Add integration smoke tests around the CLI

**Objective:** Prove compiled CLI can run non-mutating commands.

**Files:**
- Create: `tests/supervised-cli-smoke.test.ts`

**Tests:**

- `symphony profiles validate` on temp profile
- `symphony run <profile> --dry-run --json` with mocked/injected adapters where possible
- `symphony runs verify <run_id>` on generated dry-run
- legacy daemon parse path still works or exits as before

---

## Slice 10: Documentation and migration notes

### Task 32: Add supervised README

**Objective:** Make v1 usable without reading the full spec.

**Files:**
- Create: `docs/supervised-profile-v1-quickstart.md`
- Modify: `docs/supervised-profile-v1-spec.md` only if implementation changes require spec corrections

Include:

- install/build commands
- profile init example
- doctor/validate
- dry-run
- real run
- recovery commands
- known non-goals

---

## Final verification checklist

Run:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Manual local smoke:

```bash
node dist/index.js profiles init test-profile --repo /Users/homebase/marketsavvy
node dist/index.js profiles validate test-profile
node dist/index.js profiles show test-profile --json
node dist/index.js run test-profile --dry-run --json
```

Expected:

- no secrets printed
- dry-run performs no Linear/GitHub mutation
- generated run record verifies
- legacy daemon mode still starts/validates as before when using existing `clients/*.WORKFLOW.md`

---

## First implementation recommendation

Start with Slices 1–3 only:

```text
CLI routing -> profile schema/commands -> run records/state machine
```

Do **not** touch Linear mutation, Codex, worktrees, or GitHub PRs until the local deterministic substrate is tested. That substrate is the safety layer for everything else.
