# Security Policy

## Supported versions

Ripper is pre-1.0. Security fixes are made on `main` until the project starts publishing versioned releases.

## Credential handling

Never commit real credentials to this repository. In particular, do not commit:

- `.env` files
- Linear API keys
- Jira tokens
- GitHub tokens
- Codex/OpenAI credentials
- SSH private keys
- raw logs or debug bundles that may contain tokens
- local run records if they include private issue text, branch names, or repository paths that should not be public

Use `.env.example` only for placeholder variable names. Real values belong in local environment files, OS keychains, or CI secret stores.

## Redaction expectations

Bug reports and issues should redact:

- tokens, passwords, API keys, cookies, session IDs
- private repo URLs if sensitive
- customer/patient/user data
- local absolute paths when they reveal sensitive usernames or directory structures
- raw tracker issue bodies if they contain private information

Use `[REDACTED]` for removed values.

## Reporting a vulnerability

Open a private security advisory on GitHub if available. If that is not available, contact the maintainer directly and avoid posting exploit details in a public issue.

A good report includes:

- affected command or workflow
- impact
- minimal reproduction steps
- whether credentials or private data could be exposed
- suggested fix, if known

## Operational safety notes

Ripper mutates external systems: GitHub, Git repositories, and issue trackers. Treat new profiles and new releases as operational changes:

1. Run `symphony profiles doctor <profile>`.
2. Run `symphony run <profile> --dry-run`.
3. Start with one low-risk issue.
4. Verify the created branch, PR, CI result, and tracker handoff.
5. Use resume/recovery commands instead of manual state edits when possible.
