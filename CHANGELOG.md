# Changelog

All notable changes to Ripper/Symphony will be documented here.

## v0.1.0 - 2026-05-10

Initial production baseline release.

### Added

- Supervised one-ticket runner from tracker issue to Codex implementation attempt to GitHub PR handoff.
- Profile loading, validation, and doctor command surfaces.
- Durable local run records and repo locks.
- Dry-run mode for safe profile validation.
- Bounded Codex execution in disposable worktrees.
- Change-policy and redaction checks before GitHub-visible output.
- Validation phase using profile-defined commands.
- GitHub PR creation and required-check waiting.
- Tracker success/failure handoff.
- Conservative post-PR resume support for `pr_created`, `ci_running`, and `ci_completed` states.
- Idempotent Linear success handoff on resumed `ci_completed` runs.
- GitHub Actions CI for typecheck, build, and tests.
- Baseline documentation: README, quickstart, security policy, and install guide.

### Notes

- The GitHub repository is named `ripper`; the v0.1 package and CLI command still use the historical `symphony` name.
- v0.1.0 is intended for controlled local/operator use, not broad unattended backlog autonomy.
