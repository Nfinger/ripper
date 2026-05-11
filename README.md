# Ripper

Ripper is a conservative supervised coding-agent runner. It connects a tracker issue to one bounded Codex implementation attempt, validates the result locally, opens a GitHub PR, waits for CI, and hands the work back to the tracker with an auditable local run record.

The codebase and CLI still use the historical `symphony` package/command name in v0.1. The GitHub project name is `ripper`.

## What Ripper does

```text
symphony run <profile>
  -> load an explicit supervised profile
  -> create a durable local run record
  -> select exactly one eligible tracker issue
  -> claim the issue
  -> create a deterministic branch and disposable worktree
  -> run one non-interactive Codex implementation attempt
  -> verify the resulting commits and working tree
  -> run profile-defined validation commands
  -> push a branch and create a non-draft GitHub PR
  -> wait for required GitHub CI checks
  -> update the tracker and post a handoff comment
```

## What Ripper intentionally does not do yet

- No broad backlog autonomy.
- No multi-ticket batching.
- No auto-merge.
- No deploy/release automation.
- No hidden setup hooks before Codex runs.
- No external side effects performed directly by Codex.
- No resume before a PR exists; current resume support is conservative and post-PR only.

## Requirements

- macOS or Linux
- Node.js 20+
- pnpm
- Git
- GitHub CLI (`gh`) authenticated for the target repo
- Codex CLI authenticated locally
- Tracker credentials for the profiles you run, for example Linear or Jira

## Install for local development

```bash
git clone git@github.com:Nfinger/ripper.git
cd ripper
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Run the CLI from source during development:

```bash
pnpm build
node dist/index.js --help
```

Or link the package locally:

```bash
pnpm build
pnpm link --global
symphony --help
```

## Configuration

Copy the example env file and fill in real values locally. Never commit `.env`.

```bash
cp .env.example .env
```

Profiles live under the central Symphony/Ripper home directory, currently `~/.symphony`. See:

- `docs/supervised-profile-v1-spec.md`
- `docs/supervised-profile-v1-implementation-plan.md`

Useful profile commands:

```bash
symphony profiles list
symphony profiles show <profile>
symphony profiles validate <profile>
symphony profiles doctor <profile>
```

## Common commands

Dry-run a profile without mutating GitHub/tracker state:

```bash
symphony run <profile> --dry-run
```

Run exactly one eligible issue:

```bash
symphony run <profile>
```

Run a specific eligible issue:

```bash
symphony run <profile> --issue ABC-123
```

Resume a conservative post-PR run:

```bash
symphony run <profile> --resume <RUN_ID>
```

Inspect run records:

```bash
symphony runs list
symphony runs show <RUN_ID>
symphony runs verify <RUN_ID>
```

Inspect or release repo locks:

```bash
symphony locks status <repo-path>
symphony locks unlock <repo-path> --reason "operator-confirmed stale lock"
```

## Safety model

Ripper owns orchestration and external side effects. Codex receives a bounded prompt and works in a disposable worktree. Ripper verifies the resulting commits, checks the changed file policy, runs validation, creates the PR, waits for CI, and performs tracker handoff.

Run records and locks are local and auditable. Resume paths validate profile identity, issue identity, PR metadata, expected branch names, and current run status before continuing.

## Development verification

```bash
pnpm typecheck
pnpm build
pnpm test
```

CI runs the same checks on GitHub Actions.

## Security

Do not commit credentials, `.env`, raw logs with tokens, local run bundles containing secrets, or tracker/GitHub tokens. See `SECURITY.md` for reporting and handling guidance.

## License

MIT. See `LICENSE`.
