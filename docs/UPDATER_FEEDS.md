# Updater Feed Operations

Kimi Code Desktop publishes one immutable Windows release and two byte-identical GitHub Pages feeds. The canonical source repository is fixed to `Leonxlnx/kimi-code-desktop`. The permanent compatibility URL is `https://leonxlnx.github.io/tasty-desktop/`, served from `Leonxlnx/Leonxlnx.github.io`, branch `main`, directory `tasty-desktop/`.

The old source repository name must remain unclaimed after it is renamed from `tasty-desktop` to `kimi-code-desktop`. This preserves GitHub's source-repository redirect. Do not create a replacement `Leonxlnx/tasty-desktop` repository.

## Publication contract

The release workflow runs only from the canonical repository's default branch through `workflow_dispatch` with a required `tag` input such as `v0.12.0`. A tag push alone does not publish a release. The workflow must reject a dispatch when any of these conditions is false:

- `github.repository` is exactly `Leonxlnx/kimi-code-desktop`.
- The workflow ref is the canonical default branch.
- The requested annotated tag exists remotely and points exactly to the current `origin/main` commit checked out by the workflow.
- The requested tag, desktop package metadata, Rust package metadata, runtime metadata, and release notes contain the same semantic version.
- `UPDATER_FEED_MODE` is exactly `dual`.
- `LEGACY_FEED_REPOSITORY` is exactly `Leonxlnx/Leonxlnx.github.io`.
- The canonical release and both update feeds can be verified or advanced together.

The workflow is fail-closed. A successful canonical release is not reported as a successful publication until both Pages endpoints contain the verified payload. A rerun may resume an incomplete publication, but it may not replace an immutable release asset or accept feed drift.

### Exact release payload

For tag `vX.Y.Z`, the GitHub Release contains exactly these four assets:

1. `Kimi-Code-X.Y.Z-x64-setup.exe`
2. `Kimi-Code-X.Y.Z-x64-setup.exe.sig`
3. `latest.json`
4. `SHA256SUMS.txt`

For releases created by the current workflow, the canonical `gh-pages` root and the legacy `tasty-desktop/` directory contain the same current four files. Pages also retains installer and signature pairs from older versions so historical feed links remain available. The current four files must be byte-identical across the GitHub Release, canonical feed, and legacy feed. Do not rewrite the URL, whitespace, encoding, timestamp, signature, or line endings in either feed copy.

The one-time v0.8.3 bootstrap is a documented legacy exception. Its preserved GitHub Release uses `Kimi-Code-Desktop-0.8.3-x64-setup.exe`, a 725-byte CRLF `latest.json`, and a 105-byte CRLF checksum file. Those exact four Release assets are the bootstrap authority. The current raw `gh-pages` blobs contain semantically equal 714-byte and 104-byte LF text variants; treat that as historical equal-version drift and repair it only through the separately approved migration. Keep the existing v0.8.3 Pages URL unchanged because it becomes valid when the same repository is renamed. Do not run v0.8.3 through the current release workflow.

For releases created by the current workflow, `latest.json` points to the immutable asset in the canonical GitHub Release. Both Pages endpoints deliver the same signed manifest:

- `https://leonxlnx.github.io/kimi-code-desktop/latest.json`
- `https://leonxlnx.github.io/tasty-desktop/latest.json`

## GitHub configuration

### Canonical repository

Configure these repository variables in `Leonxlnx/kimi-code-desktop`:

| Variable | Required value |
| --- | --- |
| `UPDATER_FEED_MODE` | `dual` |
| `LEGACY_FEED_REPOSITORY` | `Leonxlnx/Leonxlnx.github.io` |
| `LEGACY_FEED_APP_ID` | The numeric ID of the dedicated GitHub App |

Create these protected environments:

| Environment | Secrets | Purpose |
| --- | --- | --- |
| `release-signing` | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Build and verify updater-signed Windows artifacts |
| `legacy-update-feed` | `LEGACY_FEED_APP_PRIVATE_KEY` | Mint a short-lived installation token for the user-site repository |
| `github-pages` | None | Deploy the already committed canonical `gh-pages` tree with OIDC |

The three variables remain at repository scope. Do not duplicate signing secrets at repository or organization scope. The migration preflight verifies that the named environments, variables, secret names, and dedicated App installation exist, but it does not create or validate environment reviewers, bypass policy, branch restrictions, rulesets, or repository Actions permissions. Apply those protection policies after the one-time history rewrite and before the first signed release. The workflow must not expose signing or App credentials to pull requests, tags, forks, or untrusted reusable workflows.

Set canonical GitHub Pages to `GitHub Actions` as its source. The release workflow keeps `gh-pages` as immutable audit history, uploads that exact branch tree with the pinned official Pages actions, and performs an explicit Pages deployment after each ordinary publication commit. This avoids relying on a `GITHUB_TOKEN` push to trigger another workflow. After the approved cutover succeeds, protect `main` with required CI checks, pull-request review, conversation resolution, linear history, and blocked force pushes and deletions. Protect `v*` tags from update and deletion. Protect `gh-pages` from force pushes and deletion while allowing the canonical repository's GitHub Actions identity to append an ordinary publication commit. Do not enable these rules before the exact leased history rewrite unless a separately reviewed bypass is proven not to block it.

### Legacy user-site repository

Install one dedicated GitHub App only on `Leonxlnx/Leonxlnx.github.io`. Give it only these repository permissions:

- Metadata: read-only
- Contents: read and write

Do not grant Actions, administration, deployments, environments, issues, members, pull requests, secrets, or organization access. The canonical workflow mints a short-lived installation token with `actions/create-github-app-token` pinned to commit `67018539274d69449ef7c02e8e71183d1719ab42` (v2.1.4). Do not replace the full commit pin with a mutable tag.

Set user-site Pages to `Deploy from a branch`, with `main` at `/ (root)`. After its one-time exact CAS succeeds, protect `main` from force pushes and deletion, require linear history, and give only the dedicated GitHub App the narrow bypass needed to append feed commits. The App permission applies to the repository, so the workflow provides the narrower enforcement boundary: it hardcodes `tasty-desktop/`, rejects traversal, stages only files below that directory, and fails if the commit would modify any unrelated path.

Preserve all desired unrelated user-site files. Do not add release automation or application source to this repository. Omit a stale root `CNAME` during migration unless the custom domain and valid TLS configuration are deliberately restored and verified. A broken `CNAME` can prevent both updater paths from being served safely.

No personal access token (PAT), deploy key, password, or long-lived installation token is permitted. `GITHUB_TOKEN` is used only for the canonical repository. The dedicated App token is used only for `Leonxlnx/Leonxlnx.github.io` and expires automatically.

### Migration executor App authentication

The one-time migration executor authenticates the dedicated legacy-feed App directly. Pass the App's RSA private-key file explicitly to every `verify` or `apply` invocation:

```powershell
node scripts/execute-approved-migration.mjs verify `
  --manifest dist/migration/2026-08-08/MIGRATION_APPROVAL.json `
  --expected-manifest-sha256 <approved-manifest-sha256> `
  --workspace-root E:\KimiCodeDesktop `
  --legacy-feed-app-private-key C:\path\outside\the\workspace\legacy-feed-app.private-key.pem
```

The PEM path must be absolute, outside the workspace, and point directly to a regular non-symlink file. The executor opens it once, verifies the stable file identity, imports the RSA key, clears the read buffer, and uses a short-lived App JWT only to inspect the exact installation and repository scope. It never copies the PEM into migration evidence, a plan, the journal, logs, Git history, or a repository. `apply` requires the same argument in addition to its approval file and plan arguments. Do not move the PEM into this repository or pass its contents on the command line.

## One-time repository migration

Use this order to preserve the old updater URL, the source-repository redirect, and unrelated user-site content:

1. Freeze release publication. Do not create a new version during the migration.
2. Download the current four assets from the existing Release and capture raw Git blobs from canonical `gh-pages`. Record their SHA-256 hashes, record the known text line-ending drift, verify semantic manifest/checksum equality, and verify the updater signature using the public key embedded in `tauri.conf.json`. Treat the exact Release bytes as bootstrap authority and preserve any older versioned installer/signature pairs already served by Pages.
3. Export the desired files from `Leonxlnx/Leonxlnx.github.io`. Inventory the two commits containing personal email addresses, then build one clean parentless root commit using `Leon Lin <219127460+Leonxlnx@users.noreply.github.com>`. Preserve the intended unrelated site content, but do not retain either private-history parent.
4. Remove the stale root `CNAME` from the sanitized tree unless its custom domain and TLS certificate have first been fixed and verified. Record this decision in the migration evidence.
5. Preseed `tasty-desktop/` in the sanitized user-site tree with the exact authoritative Release bytes and retained older versioned installer/signature pairs. Add a root `.nojekyll`. Compare every committed blob with `git hash-object --no-filters` of its source and reject any clean-filter, LFS, encoding, or line-ending change. A valid `tasty-desktop/latest.json` is a hard prerequisite; normal release automation never creates the first legacy feed.
6. Run the public-history and privacy checks against the complete sanitized user-site history. Confirm that the two personal-email commits no longer expose the addresses and that no desired unrelated site file was lost.
7. Prepare and verify the sanitized user-site history locally through the one-time migration procedure described below. Do not publish it yet. Before the source rename, verify the committed user-site blobs directly; the public `/tasty-desktop/` route is still shadowed by the old project Pages site and cannot prove final routing yet. Publication belongs exclusively to the manifest-approved executor in step 10.
8. Prepare and locally qualify the sanitized Kimi Code Desktop source root, a separately sanitized parentless v0.8.3 root and annotated tag, and one ordinary canonical `gh-pages` repair commit whose parent is exactly the observed old `gh-pages` tip. Confirm public-history gates, exact source trees, release configuration, and raw committed feed blob equality.
9. Inventory every public source ref and every open pull request. Record the exact old and approved new `main` SHAs, old and approved new v0.8.3 tag-object/commit/tree SHAs, old and approved new `gh-pages` SHAs, every unsafe branch name with its expected old SHA, pinned pull-request identities, repository IDs, Pages configuration, Release assets, and local evidence hashes. Create the three named environments and required variables/secrets, then install the dedicated legacy-feed App only on `Leonxlnx/Leonxlnx.github.io` with exactly Metadata read and Contents write. Record those migration prerequisites separately from the deferred repository-protection contract. Hash the final immutable JSON manifest and obtain approval only in the exact form `APPROVE CLEAN-ROOT MIGRATION MANIFEST <lowercase-manifest-sha256>`. An approval string that lists only destination object IDs is insufficient because it does not bind the old leases or the rest of the contract.
10. Execute the separately approved source-history compare-and-swap. Publish the approved user-site root through its own exact lease. Apply every source-repository ref mutation in one `git push --atomic` transaction: replace `main` with its exact lease, retarget v0.8.3 with its exact tag-object lease, fast-forward `gh-pages`, and lease-delete every enumerated unsafe branch. Never fall back to sequential source pushes when the server rejects the atomic transaction. Preserve the v0.8.3 Release record and its four uploaded assets unchanged. Stop on any stale lease or unexpected ref.
11. Verify the resulting remote head/tag manifest, complete public-source scan, v0.8.3 Release ID, asset IDs, hashes, signature, and ordinary `gh-pages` ancestry. Pull-request refs and public forks cannot be rewritten by this procedure; keep the private evidence and use GitHub Support for any required cached-object or fork-network remediation.
12. Rename the same existing source repository from `Leonxlnx/tasty-desktop` to `Leonxlnx/kimi-code-desktop`. Do not create a new repository with the vacated name. Verify the stable repository ID, stars/forks, source redirect, canonical remote, default branch, pinned environments and variables, release assets, and Pages endpoint. This proves cutover state, not repository-protection or release readiness.
13. Reconfirm that the already-installed dedicated GitHub App remains selected for only `Leonxlnx/Leonxlnx.github.io`, that its App ID matches `LEGACY_FEED_APP_ID`, and that its permissions remain exactly Metadata read and Contents write. Confirm that the workflow is restricted to `tasty-desktop/`.
14. Verify both final Pages URLs with local shell requests and byte comparisons. Do not continue while either URL redirects incorrectly, returns stale content, or differs from the recorded Release payload.
15. Configure and independently review the post-cutover branch/tag rulesets, environment reviewer and bypass policies, and repository Actions permissions described above. Confirm that they protect ordinary operation without granting an unsafe bypass to the solo owner or the release workflow.
16. Create the annotated `v0.12.0` release tag on the clean canonical `main` and exercise the dual-feed workflow. Never dispatch v0.8.3 through the current workflow.
17. Unfreeze releases only after the canonical Release and both Pages feeds pass deterministic verification.

### Offline preparation helper

Use `scripts/prepare-feed-migration.mjs` only for the approval-gated bootstrap described above. The `prepare` command accepts the two verified backup bundles and their SHA-256 hashes, the observed `gh-pages` and user-site commit IDs, the exact four-file Release capture, the hash-pinned signature witness, the local Cargo executable, `tauri.conf.json`, three fresh output paths, the explicit `omit` CNAME decision, the approved noreply identity, and a fixed commit date. It creates:

- one ordinary canonical `gh-pages` repair commit whose parent is the observed `gh-pages` tip;
- one clean parentless user-site `main` containing the preserved unrelated files and `tasty-desktop/` compatibility feed;
- one external JSON evidence file that records the inputs, raw blobs, ancestry, identity, signature result, and output object IDs.

Run `verify` with the identical arguments after `prepare`. Both commands execute the Rust updater-signature verifier through `cargo run --offline --locked`, verify the hash-pinned witness, use only local Git plumbing, reject existing or nested outputs, and never clone, fetch, push, add a remote, or contact an HTTP endpoint. Keep the bundles, generated repositories, and evidence under an ignored private migration directory. Never add them to the public source repository.

The user-site repository currently requires a one-time sanitized root replacement because two existing commits expose personal email addresses. This is the only permitted history replacement and is never performed by release automation:

1. Create and verify an offline bundle containing every existing ref, and record the observed `Leonxlnx.github.io/main` tip.
2. Build the approved parentless root commit locally, preserving desired unrelated files and preseeded updater content while omitting both old commits and using `Leon Lin <219127460+Leonxlnx@users.noreply.github.com>`.
3. Re-read the remote `main` tip immediately before publication and require it to equal the recorded old SHA. Do not refresh the lease automatically if it changed.
4. Obtain separate, explicit owner approval for the old SHA, new root SHA, backup location, privacy report, file manifest, and root `CNAME` decision.
5. Perform one compare-and-swap push from the observed old tip to the approved new root. The exact Git form is `git push --force-with-lease=refs/heads/main:<observed-old-main-sha> origin <new-root-sha>:refs/heads/main`. This represents the approved `<observed-old-main-sha>:<new-root-sha>` replacement; it must fail if the remote moved.
6. Verify the new remote SHA, public history, desired unrelated files, updater bytes, and both Pages URLs against the approved evidence.
7. Immediately protect user-site `main` against future force pushes and deletion.

Do not delete or recreate the user-site repository, use a PAT, use an unqualified `--force`, broaden the lease after a failure, or perform this replacement from the release workflow. After the clean root is established, every updater publication is an ordinary fast-forward, no-force commit.

The source repository requires its own separately approved ref migration. A verified private bundle must contain every current ref before any mutation. The approval evidence must enumerate the old and new `main`, v0.8.3 tag, canonical `gh-pages`, and every non-Pages branch. Use exact per-ref leases and one approved destination per changed ref. Never push the local development repository with `--mirror`, never publish private Kimi/Codex checkpoint refs, never broaden a failed lease, and never delete or recreate the v0.8.3 Release or its uploaded assets. The sanitized v0.8.3 tag move is a one-time privacy migration, not a normal release action.

The migration journal is keyed by the approved manifest digest. Each irreversible step is verified remotely before its completion record is written atomically. A first run accepts only the complete approved-old state. A resume may accept an exact approved-new step only when a terminal hash-chained `step-started` record proves that all preceding steps completed; recovery writes an explicit `step-recovered` record before continuing. Any unjournaled old/new mixture, extra ordinary branch or tag, extra open pull request, third object ID, changed PR identity, altered Release asset, widened permission, or non-completed workflow in `queued`, `in_progress`, `waiting`, `pending`, `requested`, or `action_required` state aborts without rollback or lease refresh. The executor's terminal result proves only the approved repository/feed cutover. Repository-protection hardening remains a separate post-cutover, pre-release gate and is not configured or verified by this executor. Final cutover verification remains incomplete until both cache-busted Pages endpoints return the exact approved Release bytes.

## Normal release procedure

1. Complete the local gates in [RELEASING.md](RELEASING.md).
2. Create and push the annotated `vX.Y.Z` tag on current `main`.
3. Dispatch `.github/workflows/release.yml` from `main` with `tag=vX.Y.Z`.
4. Approve `release-signing` only after confirming the commit and tag.
5. Approve `legacy-update-feed` only after the signed canonical artifacts pass verification.
6. Wait for the entire workflow, including canonical `gh-pages`, user-site `main`, and post-publication verification, to succeed.

Do not rerun an old workflow file from a tag or historical branch. A release always uses the reviewed workflow on the current default branch and treats the requested tag strictly as immutable build input.

The first authorization records both the tagged commit and the annotated tag-object ID. Every later signing, release, feed, and final-verification boundary must still resolve to those exact two object IDs as well as the current `main` tip. Moving both a tag and `main` during a run therefore cannot silently change the authorized release identity.

## Deterministic verification for normal releases after migration

Use GitHub CLI and local shell commands, not a browser. Download each source into a separate empty directory. For a version in `$tag`, verify:

1. The canonical GitHub Release is public, non-draft, non-prerelease, and contains exactly the four expected case-sensitive names.
2. The PE product and file versions equal the tag version.
3. `SHA256SUMS.txt` contains exactly the lowercase SHA-256 of the installer and its exact filename.
4. The base64-decoded signature verifies the installer with the updater public key embedded in `apps/desktop/src-tauri/tauri.conf.json`.
5. `latest.json` is in the deterministic canonical format generated by the current workflow, is valid UTF-8 JSON without a BOM, ends in one LF, reports the exact semantic version and tagged commit timestamp, contains only `windows-x86_64`, embeds the exact signature text, and points to the canonical immutable Release URL. The one-time v0.8.3 bootstrap instead requires its exact authoritative CRLF Release bytes and separate historical verifier.
6. The current four files downloaded from canonical Pages match the Release files by SHA-256.
7. The current four files downloaded from legacy Pages match the Release files by SHA-256.
8. The canonical `gh-pages` head and user-site `main` head are ordinary descendants of the approved post-migration baselines. Normal release publication never rewrites either history.
9. The legacy publication commit changes only paths below `tasty-desktop/`; unrelated user-site files and hashes remain unchanged.

Use a unique query string on Pages verification requests to avoid accepting a cached response, and still compare downloaded bytes rather than trusting HTTP metadata. Record the tag, source commit, workflow run ID, canonical feed commit, user-site commit, asset names, hashes, signature result, and user-site path diff in the release evidence.

The one-time migration has separate verification evidence: exact old/new compare-and-swap pairs, all affected source refs, clean-root and sanitized-tag scans, unchanged v0.8.3 Release/asset identities, raw feed blob equality, the explicit `CNAME` omission, and the post-rename routing result for both public endpoints.

## Version and race behavior

The canonical repository requires a preseeded `gh-pages` branch with a valid root `latest.json`. The user-site repository requires a preseeded `main` branch with a valid `tasty-desktop/latest.json`. A missing branch, missing manifest, or invalid manifest fails closed and must be repaired through the controlled preseed procedure before rerunning. Normal release automation never bootstraps either feed.

After those prerequisites are met, the updater publisher follows these rules independently for each feed location:

- Existing version is lower: append one ordinary commit containing the new byte-identical payload.
- Existing version is equal and all four current files are byte-identical: report idempotent success without a commit.
- Existing version is equal but any byte in the current four files differs or any current file is missing: fail for equal-version drift.
- Existing version is higher: fail as an attempted rollback.
- Existing GitHub Release for the tag has a different asset set or different bytes: fail as immutable-release drift.

The publisher records the remote head whose files passed the version and byte checks, then refetches that head immediately before push. Before any push, it also compares each committed feed blob with the raw source-file object ID so `.gitattributes`, line-ending conversion, LFS, or another clean filter cannot alter the signed payload. Git object immutability makes an unchanged head proof that the validated snapshot is unchanged. Push without force. If another run changes either remote, the changed-head or non-fast-forward check must fail. On a clean rerun, publication succeeds only from the new verified head or when it observes the exact idempotent state. This protects unrelated user-site updates as well as the feed. Repository-wide concurrency settings reduce races but are not a substitute for these checks.

The workflow must not silently continue when the App token cannot be minted, an environment approval is missing, Pages is unavailable, a remote head changed, an unrelated user-site path would change, or one feed failed. Canonical-only publication is incomplete while `UPDATER_FEED_MODE=dual`.

## Recovery

- Build or signature failure: fix the source or protected secret, then rerun the same default-branch dispatch. Do not upload a locally unsigned installer.
- Release exists but a preseeded feed failed to advance: rerun the same tag. The immutable Release and any identical feed are reused; only the missing forward publication proceeds.
- Feed branch, directory, or manifest is missing: restore a valid preseed through an audited ordinary commit using the verified current Release payload, then rerun. Release automation does not create the first feed and recovery must not rewrite history.
- App token expired or was revoked: confirm the dedicated App installation and environment secret, then rerun to mint a new short-lived token.
- Equal-version drift: stop publication, preserve both remote heads, download all variants, inspect audit logs, and identify the unauthorized or partial write. After the canonical Release is proven authoritative, repair through an approved ordinary commit and rerun verification. Never overwrite the Release assets.
- Higher-version feed or accidental bad release: do not roll the feed backward and do not move or recreate a tag. Publish a corrected version with a greater semantic version. If safety requires an outage, disable the affected Pages site until the forward fix is available.
- Race, unrelated user-site update, or non-fast-forward rejection: refetch and rerun from the new head. Never resolve it with `--force`, `--force-with-lease`, branch deletion, or history replacement.
- Compromised signing key or GitHub App key: suspend publication, revoke the credential, preserve audit evidence, rotate it in the protected environment, and follow the security incident process before publishing again.

The permanent compatibility promise applies to the legacy Pages URL and updater public key. Removing `tasty-desktop/`, claiming the old repository name with a new repository, changing the endpoint, rewriting publication history, or rotating the updater key without an explicit client migration would strand installed versions and is not a normal release operation.
