# Changelog

All notable changes to Ripper/Symphony will be documented here.

## v0.2.0 - 2026-05-11

Agent review, remediation, smoke verification, and repo-local project knowledge release.

### Added

- Independent agent code review as a hard gate after implementation commits.
- Bounded autonomous remediation loop for `REQUEST_CHANGES` review outcomes.
- Profile-driven smoke verification gate before validation and PR handoff, suitable for Playwright/UI checks or backend smoke commands.
- First-class review/remediation/verification run statuses and terminalization coverage.
- Repo-local Project Knowledge Center support through profile `knowledge` includes.
- Safe prompt injection for target-repo specs, ADRs, user-flow docs, API docs, runbooks, and developer docs.
- Documentation-impact contract requiring implementation agents to report affected durable project docs.
- Independent review checklist for stale/missing project documentation.
- Generated profile template with review, verification, and knowledge-center defaults.

### Changed

- Agent review verdict parsing now fails closed unless the final non-empty line is an exact supported verdict.
- Review feedback used for remediation and shareable artifacts is redacted before reuse.
- Project knowledge is bounded by UTF-8 byte caps, delimited per file, and protected by prompt-precedence guardrails.

### Security

- Knowledge includes reject absolute paths and `..` escapes.
- Candidate knowledge files are realpath-checked and symlink escapes outside the target repository are skipped.
- Injected project knowledge cannot override Symphony safety rules, path restrictions, `DO NOT` rules, or output contracts.

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
