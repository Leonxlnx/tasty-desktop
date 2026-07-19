# Release Process

Published Windows releases are built by GitHub Actions. Do not upload a locally unsigned installer as an official release.

## Prerequisites

- The working tree is clean.
- CI passes on `main`.
- The version matches in:
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - `apps/desktop/src-tauri/Cargo.lock`
- GitHub Actions contains `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `docs/releases/vX.Y.Z.md` contains reviewed English release notes.
- No Kimi task, queued prompt, or approval is active during local install verification.

## Local verification

Run:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:services
git diff --check
pnpm audit --prod
```

For local installation testing only:

```powershell
pnpm bundle:local
```

The local installer is intentionally unsigned when the protected updater key is unavailable. It must not replace a signed GitHub release asset.

## Public-source check

Before tagging:

1. Confirm the reachable Git history contains only public-source commits.
2. Confirm local checkpoint refs, work logs, credentials, `docs/spec`, and `docs/reference` are not pushed.
3. Scan tracked files for tokens, private keys, personal paths, account data, and hard-coded credentials.
4. Check that all public Markdown is English and contains no Unicode em dash.
5. Confirm `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and the release notes match the version being published.

## Publish

Create and push an annotated tag whose version exactly matches the Tauri configuration:

```powershell
git tag -a v0.8.3 -m "Kimi Code Desktop 0.8.3"
git push origin v0.8.3
```

The `Windows release` workflow:

1. Installs locked Node and Rust dependencies.
2. Runs typechecks and tests.
3. Builds an updater-signed NSIS installer.
4. Creates the updater manifest and SHA-256 checksums.
5. Publishes the GitHub Release with reviewed notes.
6. Replaces the GitHub Pages update feed with the signed release files.

## Verify

Verify through GitHub CLI and local shell commands:

- Workflow conclusion is `success`.
- Release is public and not a draft or prerelease.
- Installer, `.sig`, `latest.json`, and `SHA256SUMS.txt` exist.
- Installer SHA-256 matches `SHA256SUMS.txt`.
- `latest.json` version and URL match the tag.
- GitHub Pages reports a built deployment.
- A supported installed build detects and verifies the update.

Microsoft Authenticode signing is separate from Tauri updater signing. Until Authenticode is configured, Windows SmartScreen may report an unknown publisher.
