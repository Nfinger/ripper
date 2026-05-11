# Quickstart

This guide gets a local development checkout to the point where you can validate a supervised profile and run one safe dry run.

## 1. Install prerequisites

Required locally:

- Node.js 20+
- pnpm
- Git
- GitHub CLI (`gh`) authenticated for the target repositories
- Codex CLI authenticated locally
- Tracker credentials for your profile, such as Linear or Jira

Check basics:

```bash
node --version
pnpm --version
git --version
gh auth status
```

## 2. Clone and verify the repo

```bash
git clone git@github.com:Nfinger/ripper.git
cd ripper
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

## 3. Configure local environment

```bash
cp .env.example .env
```

Edit `.env` and replace placeholders with real local values. Do not commit `.env`.

## 4. Configure or inspect profiles

Profiles live under `~/.symphony` in the current v0.1 implementation.

Useful commands:

```bash
symphony profiles list
symphony profiles show <profile>
symphony profiles validate <profile>
symphony profiles doctor <profile>
```

If you are running from the checkout instead of a linked global CLI, build first and use `node dist/index.js` in place of `symphony`.

```bash
pnpm build
node dist/index.js profiles list
```

## 5. Dry-run first

```bash
symphony run <profile> --dry-run
```

A dry run should prove that the profile can load and that one eligible issue can be selected without mutating GitHub or the tracker.

## 6. Run one controlled issue

Prefer a specific low-risk issue for the first real run:

```bash
symphony run <profile> --issue ABC-123
```

Then verify:

- a local run record was created
- a deterministic branch/worktree was used
- Codex made bounded commits
- validation passed
- a non-draft GitHub PR was opened
- required GitHub checks passed
- the tracker issue received the expected handoff

## 7. Recovery

Inspect runs:

```bash
symphony runs list
symphony runs show <RUN_ID>
symphony runs verify <RUN_ID>
```

Resume conservative post-PR states:

```bash
symphony run <profile> --resume <RUN_ID>
```

Inspect locks:

```bash
symphony locks status <repo-path>
```

Only unlock after confirming the run is no longer active:

```bash
symphony locks unlock <repo-path> --reason "operator-confirmed stale lock"
```
