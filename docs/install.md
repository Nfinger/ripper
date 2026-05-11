# Install and Release Guide

Ripper is currently distributed as a Node.js/TypeScript CLI package built from this repository. The repo/product name is `ripper`; the v0.1 executable is still `symphony`.

## Requirements

- Node.js 20+
- pnpm 10.33.3+
- Git
- GitHub CLI (`gh`) authenticated for target repositories
- Codex CLI authenticated locally
- Tracker credentials required by your profiles, such as Linear or Jira

## Install from source

```bash
git clone git@github.com:Nfinger/ripper.git
cd ripper
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
symphony --help
```

If you do not want to link globally, use the built entrypoint directly:

```bash
node dist/index.js --help
```

## Install from a GitHub release artifact

Download the release package from the GitHub release page, then install globally with npm or pnpm.

```bash
npm install --global ./symphony-0.1.0.tgz
symphony --help
```

The tarball is produced by `pnpm pack` after `pnpm build`, so it contains compiled `dist/` files plus docs and package metadata.

## Local configuration

Copy the example env file and fill in local-only credentials:

```bash
cp .env.example .env
```

Never commit `.env`.

Profiles live under `~/.symphony` in v0.1. See:

- `docs/quickstart.md`
- `docs/supervised-profile-v1-spec.md`

## Verify an install

```bash
symphony profiles list
symphony profiles doctor <profile>
symphony run <profile> --dry-run
```

For a first real run, prefer a specific low-risk issue:

```bash
symphony run <profile> --issue ABC-123
```

## Release process

1. Confirm `main` is clean and current.
2. Update `CHANGELOG.md`.
3. Confirm `package.json` version matches the intended tag.
4. Run local verification:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm build
   pnpm test
   pnpm pack --pack-destination dist-release
   ```

5. Push changes to `main` and wait for CI to pass.
6. Create and push a version tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

7. The release workflow builds, tests, packs the tarball, and creates a published GitHub Release.
8. Verify the release:

   ```bash
   gh release view v0.1.0 --repo Nfinger/ripper --json tagName,name,isDraft,isPrerelease,publishedAt,url
   ```

## Current v0.1 limitations

- No npm registry publish yet.
- No Homebrew tap yet.
- CLI command remains `symphony` while repo/product name is `ripper`.
- Releases are source/package artifacts for controlled operator installs.
