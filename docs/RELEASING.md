# Release Process

Published Windows releases are built by GitHub Actions. Do not upload a locally unsigned installer as an official release.

The canonical repository is `Leonxlnx/kimi-code-desktop`. Releases publish byte-identical artifacts to both the canonical Pages feed and the permanent `/tasty-desktop/` compatibility path in `Leonxlnx/Leonxlnx.github.io`. See [Updater Feed Operations](UPDATER_FEEDS.md) for repository migration, permissions, feed invariants, verification, and recovery.

## Prerequisites

- The working tree is clean.
- CI passes on `main`.
- Windows packaging runs on Node.js v22.22.2 x64. `prepare:bundle` rejects an executable or Node license whose SHA-256 does not match the official archive.
- The version matches in:
  - `apps/desktop/package.json`
  - `apps/desktop/src-tauri/Cargo.toml`
  - `apps/desktop/src-tauri/tauri.conf.json`
  - The `kimi-code-desktop` package entry in `apps/desktop/src-tauri/Cargo.lock`
  - `apps/server/src/acp-client.ts`
  - `apps/server/src/preview-mcp.ts`
- The protected `release-signing` environment contains `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- The protected `legacy-update-feed` environment contains `LEGACY_FEED_APP_PRIVATE_KEY`.
- Repository variables are set exactly to `UPDATER_FEED_MODE=dual`, `LEGACY_FEED_REPOSITORY=Leonxlnx/Leonxlnx.github.io`, and `LEGACY_FEED_APP_ID=<GitHub App ID>`.
- The dedicated GitHub App is installed only on `Leonxlnx/Leonxlnx.github.io` with metadata read-only and contents read/write permissions.
- `docs/releases/vX.Y.Z.md` contains reviewed English release notes.
- No Kimi turn, queued prompt, background report, or approval is active during local installation verification.
- The legacy `tasty-desktop` Pages updater feed remains permanently available as a compatibility endpoint for installed builds.

## Local verification

Run:

```powershell
corepack pnpm@10.13.1 install --frozen-lockfile
corepack pnpm@10.13.1 check:public
corepack pnpm@10.13.1 typecheck
corepack pnpm@10.13.1 test
node --test scripts/release-feed.test.mjs
corepack pnpm@10.13.1 check:licenses
corepack pnpm@10.13.1 build:services
git diff --check
corepack pnpm@10.13.1 audit --prod
```

For local installation testing only:

```powershell
corepack pnpm@10.13.1 bundle:local
```

The local installer is intentionally unsigned when the protected updater key is unavailable. It must not replace a signed GitHub release asset.

Release verification uses local shell tests, builds, process inspection, loopback RPC checks, runtime logs, and file hashes only. Interactive or browser-based visual QA is outside this release gate. Release notes must describe concrete implementation and automated checks without claiming unperformed visual validation.

## Public-source check

Before tagging:

1. Run the guard from a full checkout. It scans the working tree and every blob reachable from `HEAD`, public tags, and `origin` branches; local checkpoint refs and other remotes are excluded.
2. Confirm local checkpoint refs, work logs, credentials, `docs/spec`, and `docs/reference` are not pushed.
3. Scan tracked files for tokens, private keys, personal paths, account data, and hard-coded credentials.
4. Use a GitHub noreply address instead of a personal mailbox for public commit metadata.
5. Check that public Markdown is English and contains no Unicode em dash.
6. Confirm `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and the release notes match the version being published.

## Publish

Create and push an annotated tag whose version exactly matches every field in the prerequisites:

```powershell
$version = "X.Y.Z"
git tag -a "v$version" -m "Kimi Code Desktop $version"
git push origin "v$version"
```

Pushing the tag does not start publication. Dispatch the workflow from the current default branch and pass the immutable tag as input:

```powershell
$tag = "vX.Y.Z"
gh workflow run .github/workflows/release.yml --repo Leonxlnx/kimi-code-desktop --ref main -f tag=$tag
```

Confirm the workflow run references `main` before approving the `release-signing` environment. Approve `legacy-update-feed` only after the canonical signed artifacts pass verification. A historical workflow from a tag or release branch must not receive protected credentials.

The Windows release workflow:

1. Hard-fails unless it is running in `Leonxlnx/kimi-code-desktop` from the default branch with `UPDATER_FEED_MODE=dual`.
2. Resolves the requested annotated tag, verifies that it points exactly to current `origin/main`, and records both its commit and annotated tag-object ID for every later authorization boundary.
3. If an immutable Release already exists, downloads and cryptographically verifies its exact four assets as the authoritative recovery payload. Otherwise, installs locked Node and Rust dependencies and continues with a fresh build.
4. Runs typechecks, tests, public-source checks, and the third-party license gate before a fresh build.
5. Builds an updater-signed NSIS installer, verifies its signature against the embedded public key, and creates exactly `Kimi-Code-X.Y.Z-x64-setup.exe`, `Kimi-Code-X.Y.Z-x64-setup.exe.sig`, `latest.json`, and `SHA256SUMS.txt`.
6. Preflights the canonical feed and the user-site compatibility directory before any Release or feed mutation.
7. Publishes a new immutable GitHub Release with reviewed notes or re-verifies the authoritative existing Release byte-for-byte.
8. Advances canonical `gh-pages` without force-pushing, rollback, or equal-version drift, then explicitly deploys that exact tree with the pinned official Pages actions.
9. Mints a short-lived GitHub App token and advances only `tasty-desktop/` on the user-site repository's `main` branch with byte-identical copies of the same four files.
10. Downloads the Release and both Pages payloads and fails unless all deterministic checks pass.

## Verify

Verify through GitHub CLI and local shell commands:

- Workflow conclusion is `success`.
- Release is public and not a draft or prerelease.
- Exactly `Kimi-Code-X.Y.Z-x64-setup.exe`, its `.sig`, `latest.json`, and `SHA256SUMS.txt` exist as Release assets.
- Installer SHA-256 matches `SHA256SUMS.txt`.
- `latest.json` version and URL match the tag.
- The signature in `latest.json` equals the detached signature and verifies the installer against the embedded updater public key.
- Canonical and legacy Pages each return all four files byte-identical to the GitHub Release.
- Canonical `gh-pages` and user-site `main` advanced without a force push or rollback, and the user-site commit changed only `tasty-desktop/`.
- A supported installed build detects and verifies the update.

An equal feed version is successful only when every expected file is byte-identical. Equal-version drift, a higher remote version, an unexpected Release asset, a race, or failure of either feed stops the workflow. Rerun the same default-branch dispatch after correcting the cause; never replace release assets, move tags, use a personal access token, or force-push a feed.

Microsoft Authenticode signing is separate from Tauri updater signing. Until Authenticode is configured, Windows SmartScreen may report an unknown publisher.
