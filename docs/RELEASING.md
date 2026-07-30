# Release Process

Published Windows releases are built by GitHub Actions. Do not upload a locally unsigned installer as an official release.

## Prerequisites

- The working tree is clean.
- CI passes on `main`.
- Windows packaging runs on Node.js v22.22.2 x64. `prepare:bundle` rejects an executable or Node license whose SHA-256 does not match the official archive.
- The version matches in:
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - The `kimi-code-desktop` package entry in `apps/desktop/src-tauri/Cargo.lock`
  - `apps/server/src/preview-mcp.ts`
- GitHub Actions contains `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- `docs/releases/vX.Y.Z.md` contains reviewed English release notes.
- No Kimi turn, queued prompt, background report, or approval is active during local installation verification.
- The legacy `tasty-desktop` Pages updater feed remains available until supported older installs have received a compatible transition update.

## Local verification

Run:

```powershell
corepack pnpm@10.13.1 install --frozen-lockfile
corepack pnpm@10.13.1 check:public
corepack pnpm@10.13.1 typecheck
corepack pnpm@10.13.1 test
corepack pnpm@10.13.1 build:services
git diff --check
corepack pnpm@10.13.1 audit --prod
```

For local installation testing only:

```powershell
corepack pnpm@10.13.1 bundle:local
```

The local installer is intentionally unsigned when the protected updater key is unavailable. It must not replace a signed GitHub release asset.

Verification for the supervised release process uses local shell tests, builds, process inspection, loopback RPC checks, runtime logs, and file hashes only. Do not launch the Codex in-app browser, browser MCP, Chrome control, screenshot capture, or browser-based visual QA. Release notes must describe concrete implementation and automated checks without claiming unperformed visual validation.

## Public-source check

Before tagging:

1. Confirm the reachable Git history contains only public-source commits.
2. Confirm local checkpoint refs, work logs, credentials, `docs/spec`, and `docs/reference` are not pushed.
3. Scan tracked files for tokens, private keys, personal paths, account data, and hard-coded credentials.
4. Check that public Markdown is English and contains no Unicode em dash.
5. Confirm `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and the release notes match the version being published.

## Publish

Create and push an annotated tag whose version exactly matches every field in the prerequisites:

```powershell
$version = "X.Y.Z"
git tag -a "v$version" -m "Kimi Code Desktop $version"
git push origin "v$version"
```

The Windows release workflow:

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
