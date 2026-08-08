import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkMigrationApproval } from "./check-migration-approval.mjs";

const execFileAsync = promisify(execFile);
const APPROVAL_FORMAT = "APPROVE CLEAN-ROOT MIGRATION MANIFEST <sha256-of-this-file>";
const identityEnvironment = {
  GIT_AUTHOR_NAME: "Migration Test",
  GIT_AUTHOR_EMAIL: "migration@example.test",
  GIT_AUTHOR_DATE: "2026-08-08T12:00:00.000Z",
  GIT_COMMITTER_NAME: "Migration Test",
  GIT_COMMITTER_EMAIL: "migration@example.test",
  GIT_COMMITTER_DATE: "2026-08-08T12:00:00.000Z",
};

test("approve verifies every artifact and repository and prints the exact manifest-hash phrase", async () => {
  await withFixture(async (fixture) => {
    const result = await checkMigrationApproval({ ...fixture.options, mode: "approve" });
    const manifestHash = sha256(await readFile(fixture.options.manifest));
    assert.equal(result.eligible, true);
    assert.equal(result.manifestSha256, manifestHash);
    assert.equal(result.approvalPhrase, `APPROVE CLEAN-ROOT MIGRATION MANIFEST ${manifestHash}`);
    assert.equal(result.artifacts.length, 5);
    assert.deepEqual(Object.values(result.repositories).map((entry) => entry.fsck), ["clean", "clean", "clean", "clean"]);
    const inspection = await checkMigrationApproval(fixture.options);
    assert.equal(inspection.eligible, true);
    assert.equal(inspection.approvalPhrase, undefined);

    const cli = await execFileAsync(process.execPath, [resolve("scripts/check-migration-approval.mjs"), "approve", ...cliArguments(fixture.options)], {
      cwd: resolve("."),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cli.stdout.trimEnd(), result.approvalPhrase);
    assert.equal(cli.stderr, "");
  });
});

test("inspect validates evidence but reports an ineligible manifest without emitting approval", async () => {
  await withFixture(async (fixture) => {
    fixture.manifest.approvalEligible = false;
    fixture.manifest.prerequisites.ready = false;
    fixture.manifest.prerequisites.requiredVariables.LEGACY_FEED_APP_ID = "<numeric-dedicated-app-id>";
    fixture.manifest.prerequisites.missingAtCapture = ["release-signing environment", "dedicated legacy-feed GitHub App installation"];
    await fixture.writeManifest();

    const result = await checkMigrationApproval(fixture.options);
    assert.equal(result.eligible, false);
    assert.equal(result.approvalPhrase, undefined);
    assert.ok(result.missing.includes("release-signing environment"));
    await assert.rejects(checkMigrationApproval({ ...fixture.options, mode: "approve" }), /not eligible.*release-signing environment/iu);

    const cli = await execFileAsync(process.execPath, [resolve("scripts/check-migration-approval.mjs"), ...cliArguments(fixture.options)], {
      cwd: resolve("."),
      encoding: "utf8",
      windowsHide: true,
    });
    assert.match(cli.stdout, /^NOT ELIGIBLE\r?\n- release-signing environment/mu);
    assert.doesNotMatch(cli.stdout, /^APPROVE CLEAN-ROOT MIGRATION MANIFEST /mu);
  });
});

test("eligible approval requires captured initial state bound to the remote snapshot", async (context) => {
  await context.test("missing captured state", async () => {
    await withFixture(async (fixture) => {
      delete fixture.manifest.capturedInitialState;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval({ ...fixture.options, mode: "approve" }), /capturedInitialState must be an object/iu);
    });
  });

  await context.test("drifted captured metadata", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.capturedInitialState.sourceRepository.metadata.description = "Drifted after capture";
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval({ ...fixture.options, mode: "approve" }), /capturedInitialState\.sourceRepository\.metadata does not match the hash-pinned remote snapshot/iu);
    });
  });
});

test("prerequisite contract rejects every unapproved field, set member, and App scope", async (context) => {
  const cases = [
    {
      name: "extra App permission",
      mutate: (manifest) => { manifest.prerequisites.requiredLegacyFeedApp.permissions.issues = "read"; },
      pattern: /requiredLegacyFeedApp\.permissions must contain exactly/iu,
    },
    {
      name: "extra environment",
      mutate: (manifest) => { manifest.prerequisites.requiredEnvironments.push("staging"); },
      pattern: /requiredEnvironments must contain exactly/iu,
    },
    {
      name: "duplicate environment",
      mutate: (manifest) => { manifest.prerequisites.requiredEnvironments.push("github-pages"); },
      pattern: /requiredEnvironments must contain exactly/iu,
    },
    {
      name: "extra environment secret",
      mutate: (manifest) => { manifest.prerequisites.requiredEnvironmentSecrets["release-signing"].push("UNRELATED_SECRET"); },
      pattern: /requiredEnvironmentSecrets\.release-signing must contain exactly/iu,
    },
    {
      name: "extra variable key",
      mutate: (manifest) => { manifest.prerequisites.requiredVariables.UNRELATED = "value"; },
      pattern: /requiredVariables must contain exactly/iu,
    },
    {
      name: "zero App ID",
      mutate: (manifest) => { manifest.prerequisites.requiredVariables.LEGACY_FEED_APP_ID = "0"; },
      pattern: /LEGACY_FEED_APP_ID must be a positive decimal integer/iu,
    },
    {
      name: "wrong installed repository",
      mutate: (manifest) => { manifest.prerequisites.requiredLegacyFeedApp.installedOnlyOn = manifest.sourceRepository.currentName; },
      pattern: /must select only the user-site repository/iu,
    },
    {
      name: "wrong permission value",
      mutate: (manifest) => { manifest.prerequisites.requiredLegacyFeedApp.permissions.contents = "read"; },
      pattern: /must select only the user-site repository/iu,
    },
  ];

  for (const entry of cases) {
    await context.test(entry.name, async () => {
      await withFixture(async (fixture) => {
        entry.mutate(fixture.manifest);
        await fixture.writeManifest();
        await assert.rejects(checkMigrationApproval({ ...fixture.options, mode: "approve" }), entry.pattern);
      });
    });
  }
});

test("fails closed on malformed hashes and changed artifacts", async (context) => {
  await context.test("malformed lowercase SHA-256", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.localEvidence.sourceZip.sha256 = "A".repeat(64);
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /64-character lowercase SHA-256/iu);
    });
  });

  await context.test("artifact byte drift", async () => {
    await withFixture(async (fixture) => {
      const changed = await readFile(fixture.artifacts.sourceZip);
      changed[0] ^= 0xff;
      await writeFile(fixture.artifacts.sourceZip, changed);
      await assert.rejects(checkMigrationApproval(fixture.options), /sourceZip SHA-256 mismatch/iu);
    });
  });
});

test("fails closed on wrong Git trees, refs, and parents", async (context) => {
  await context.test("wrong tree", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.sourceRepository.main.approvedTree = "f".repeat(40);
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /source root tree mismatch/iu);
    });
  });

  await context.test("wrong ref", async () => {
    await withFixture(async (fixture) => {
      await git(["commit", "--allow-empty", "-m", "unexpected commit"], fixture.options.sourceRepo, identityEnvironment);
      await assert.rejects(checkMigrationApproval(fixture.options), /source root ref mismatch/iu);
    });
  });

  await context.test("wrong parent", async () => {
    await withFixture(async (fixture) => {
      const replacement = (await git(["commit-tree", fixture.repositories.canonical.tree, "-m", "parentless replacement"], fixture.options.canonicalRepo, identityEnvironment)).stdout.trim();
      await git(["update-ref", "refs/heads/gh-pages", replacement], fixture.options.canonicalRepo);
      fixture.manifest.sourceRepository.ghPages.approvedNew = replacement;
      fixture.manifest.localEvidence.repositories.canonicalGhPages.commit = replacement;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /canonical gh-pages preseed parent mismatch/iu);
    });
  });
});

test("fails closed when a prepared repository has a remote or dirty worktree", async (context) => {
  await context.test("configured remote", async () => {
    await withFixture(async (fixture) => {
      await git(["remote", "add", "origin", "https://example.invalid/repository.git"], fixture.options.sourceRepo);
      await assert.rejects(checkMigrationApproval(fixture.options), /source root has a configured remote/iu);
    });
  });

  await context.test("untracked file", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.options.userSiteRepo, "untracked.txt"), "dirty\n");
      await assert.rejects(checkMigrationApproval(fixture.options), /user-site preseed is not clean/iu);
    });
  });
});

test("fails closed on unpinned PRs, unsafe execution metadata, and altered Pages/feed postconditions", async (context) => {
  await context.test("unpinned PR head", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.sourceRepository.pullRequestsToClose[0].headSha = "9".repeat(40);
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /does not match one exact branch deletion/iu);
    });
  });

  await context.test("missing atomic source-ref step", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.execution.steps.find((step) => step.id === "source-refs").kind = "read-only";
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /unexpected or duplicate execution step|exactly one atomic-source-refs/iu);
    });
  });

  await context.test("Pages endpoint drift", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.postconditions.canonicalEndpoint = "https://example.invalid/";
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /postcondition endpoints/iu);
    });
  });

  await context.test("user-site Pages URL is not the owner root", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.userSiteRepository.desiredPages.url = fixture.manifest.postconditions.legacyEndpoint;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /user-site Pages URL must be the owner's root Pages URL/iu);
    });
  });

  await context.test("feed byte drift", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.postconditions.feedFiles[0].bytes += 1;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /feed files do not exactly match/iu);
    });
  });

  await context.test("missing post-cutover repository-protection gate", async () => {
    await withFixture(async (fixture) => {
      delete fixture.manifest.deferredGates.repositoryProtections;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /deferredGates must contain exactly/iu);
    });
  });

  await context.test("extra repository-protection gate field", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.deferredGates.repositoryProtections.enforcedByExecutor = true;
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /deferredGates\.repositoryProtections must contain exactly/iu);
    });
  });

  await context.test("execution claims repository-protection completion", async () => {
    await withFixture(async (fixture) => {
      fixture.manifest.execution.steps.find((step) => step.id === "metadata-and-pages").postcondition = "Pages and required protections match.";
      await fixture.writeManifest();
      await assert.rejects(checkMigrationApproval(fixture.options), /may not configure or claim completion.*protections or rulesets/iu);
    });
  });
});

test("helper contains no network or mutation command path", async () => {
  const source = await readFile(resolve("scripts/check-migration-approval.mjs"), "utf8");
  assert.doesNotMatch(source, /from "node:(?:dns|http|https|net|tls)"/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /execFileAsync\("(?:gh|curl|wget)"/iu);
  assert.doesNotMatch(source, /runGit\(\["(?:clone|fetch|pull|push|remote|update-ref|commit|tag|checkout|reset)"/u);
  assert.deepEqual([...source.matchAll(/execFileAsync\(([^,\r\n]+)/gu)].map((match) => match[1]), ["\"git\""]);
  assert.match(source, /GIT_OPTIONAL_LOCKS: "0"/u);
  assert.match(source, /"--no-optional-locks"/u);
  assert.match(source, /GIT_NO_REPLACE_OBJECTS: "1"/u);
  assert.match(source, /GIT_NO_LAZY_FETCH: "1"/u);
});

async function createFixture(root) {
  const artifactRoot = join(root, "workspace");
  await mkdir(artifactRoot, { recursive: true });
  const source = await createRepository(join(artifactRoot, "repos", "source"), "main", ["source"]);
  const canonical = await createRepository(join(artifactRoot, "repos", "canonical"), "gh-pages", ["old pages", "repaired pages"]);
  const userSite = await createRepository(join(artifactRoot, "repos", "user-site"), "main", ["user site"]);
  const sanitized = await createRepository(join(artifactRoot, "repos", "sanitized"), "main", ["sanitized release"]);
  await git(["tag", "-a", "v0.8.3", "-m", "Kimi Code Desktop v0.8.3"], sanitized.path, identityEnvironment);
  sanitized.tagObject = (await git(["rev-parse", "refs/tags/v0.8.3"], sanitized.path)).stdout.trim();

  const artifactsDirectory = join(artifactRoot, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  const artifacts = {
    backup: join(artifactsDirectory, "before.bundle"),
    migrationEvidence: join(artifactsDirectory, "migration-evidence.json"),
    sanitizedEvidence: join(artifactsDirectory, "sanitized-evidence.json"),
    sourceZip: join(artifactsDirectory, "source.zip"),
    remoteSnapshot: join(artifactsDirectory, "remote-snapshot.json"),
  };
  await writeFile(artifacts.backup, "bundle evidence\n");
  await writeFile(artifacts.migrationEvidence, "{\"verified\":true}\n");
  await writeFile(artifacts.sanitizedEvidence, "{\"verified\":true}\n");
  await writeFile(artifacts.sourceZip, "PK deterministic source archive\n");

  const sourceOld = "1".repeat(40);
  const tagOldObject = "2".repeat(40);
  const tagOldCommit = "3".repeat(40);
  const tagOldTree = "4".repeat(40);
  const branchOld = "5".repeat(40);
  const userSiteOld = "6".repeat(40);
  const feedFiles = [
    { id: 501, name: "Kimi-Code-Desktop-0.8.3-x64-setup.exe", bytes: 123, sha256: "7".repeat(64) },
    { id: 502, name: "Kimi-Code-Desktop-0.8.3-x64-setup.exe.sig", bytes: 64, sha256: "8".repeat(64) },
    { id: 503, name: "latest.json", bytes: 256, sha256: "9".repeat(64) },
    { id: 504, name: "SHA256SUMS.txt", bytes: 96, sha256: "a".repeat(64) },
  ];
  const canonicalUrl = "https://leonxlnx.github.io/kimi-code-desktop/";
  const userSiteRootUrl = "https://leonxlnx.github.io/";
  const legacyUrl = "https://leonxlnx.github.io/tasty-desktop/";
  const capturedSourceMetadata = {
    description: "Open-source desktop harness for multiple coding agents.",
    homepage: legacyUrl,
    topics: ["agent-harness", "kimi", "multi-provider"],
  };
  const desiredSourceMetadata = {
    description: "Unofficial, open-source Windows desktop harness for Kimi Code CLI.",
    homepage: "https://github.com/Leonxlnx/kimi-code-desktop#readme",
    topics: ["agent-harness", "kimi", "kimi-code", "windows"],
  };
  const capturedSourcePages = {
    buildType: "legacy",
    source: { branch: "gh-pages", path: "/" },
    cname: null,
    httpsEnforced: true,
    url: legacyUrl,
  };
  const capturedUserSitePages = {
    buildType: "legacy",
    source: { branch: "main", path: "/" },
    cname: null,
    httpsEnforced: true,
    url: userSiteRootUrl,
  };
  const remoteSnapshot = {
    schemaVersion: 1,
    readOnlyCapture: true,
    sourceRepository: {
      id: 100,
      nodeId: "R_source",
      fullName: "Leonxlnx/tasty-desktop",
      ...capturedSourceMetadata,
      pages: {
        status: "built",
        buildType: capturedSourcePages.buildType,
        source: { ...capturedSourcePages.source },
        htmlUrl: capturedSourcePages.url,
        cname: capturedSourcePages.cname,
        httpsEnforced: capturedSourcePages.httpsEnforced,
      },
    },
    userSiteRepository: {
      id: 200,
      nodeId: "R_user_site",
      fullName: "Leonxlnx/Leonxlnx.github.io",
      pages: {
        status: "built",
        buildType: capturedUserSitePages.buildType,
        source: { ...capturedUserSitePages.source },
        htmlUrl: capturedUserSitePages.url,
        cname: capturedUserSitePages.cname,
        httpsEnforced: capturedUserSitePages.httpsEnforced,
      },
    },
  };
  await writeFile(artifacts.remoteSnapshot, `${JSON.stringify(remoteSnapshot, null, 2)}\n`);
  const manifest = {
    schemaVersion: 1,
    lastRemoteFreezeMatched: true,
    approvalRequired: true,
    approvalEligible: true,
    approvalFormat: APPROVAL_FORMAT,
    sourceRepository: {
      repositoryId: 100,
      nodeId: "R_source",
      currentName: "Leonxlnx/tasty-desktop",
      approvedName: "Leonxlnx/kimi-code-desktop",
      desiredMetadata: desiredSourceMetadata,
      desiredPages: { buildType: "workflow", cname: null, httpsEnforced: true, url: canonicalUrl },
      main: { expectedOld: sourceOld, approvedNew: source.commit, approvedTree: source.tree, action: "replace-with-exact-force-with-lease" },
      ghPages: { expectedOld: canonical.commits[0], approvedNew: canonical.commit, approvedTree: canonical.tree, action: "fast-forward-only" },
      "v0.8.3": {
        expectedOldTagObject: tagOldObject,
        expectedOldCommit: tagOldCommit,
        expectedOldTree: tagOldTree,
        approvedNewTagObject: sanitized.tagObject,
        approvedNewCommit: sanitized.commit,
        approvedNewTree: sanitized.tree,
        action: "retarget-with-exact-tag-lease-preserve-release",
      },
      branches: [{ name: "dependabot/test", expectedOld: branchOld, action: "lease-delete" }],
      pullRequestsToClose: [{
        number: 17,
        nodeId: "PR_test",
        state: "open",
        baseRef: "main",
        baseSha: sourceOld,
        headRef: "dependabot/test",
        headSha: branchOld,
      }],
    },
    userSiteRepository: {
      repositoryId: 200,
      nodeId: "R_user_site",
      name: "Leonxlnx/Leonxlnx.github.io",
      main: { expectedOld: userSiteOld, approvedNew: userSite.commit, approvedTree: userSite.tree, action: "replace-with-exact-force-with-lease" },
      cname: { decision: "omit", oldValueSha256: "b".repeat(64) },
      desiredPages: { buildType: "legacy", source: { branch: "main", path: "/" }, cname: null, httpsEnforced: true, url: userSiteRootUrl },
    },
    capturedInitialState: {
      sourceRepository: {
        metadata: capturedSourceMetadata,
        pages: capturedSourcePages,
      },
      userSiteRepository: {
        pages: capturedUserSitePages,
      },
    },
    release: {
      id: 400,
      tag: "v0.8.3",
      preserveRecordAndAssets: true,
      assets: feedFiles.map((file) => ({ ...file })),
      signatureVerified: true,
      signatureEvidenceSha256: "8".repeat(64),
    },
    privateBackups: [await artifactRecord(artifactRoot, artifacts.backup)],
    localEvidence: {
      repositories: {
        sourceRoot: repositoryRecord(artifactRoot, source, "main", null),
        canonicalGhPages: repositoryRecord(artifactRoot, canonical, "gh-pages", canonical.commits[0]),
        userSite: repositoryRecord(artifactRoot, userSite, "main", null),
        "sanitizedV0.8.3": { ...repositoryRecord(artifactRoot, sanitized, "main", null), tag: "v0.8.3", tagObject: sanitized.tagObject },
      },
      migrationEvidence: await artifactRecord(artifactRoot, artifacts.migrationEvidence),
      "sanitizedV0.8.3Evidence": await artifactRecord(artifactRoot, artifacts.sanitizedEvidence),
      sourceZip: await artifactRecord(artifactRoot, artifacts.sourceZip, true),
      remoteSnapshot: await artifactRecord(artifactRoot, artifacts.remoteSnapshot, true),
    },
    prerequisites: {
      ready: true,
      releaseFreeze: { required: true, activeReleaseWorkflowRunsAtCapture: [] },
      requiredEnvironments: ["github-pages", "release-signing", "legacy-update-feed"],
      requiredVariables: { UPDATER_FEED_MODE: "dual", LEGACY_FEED_REPOSITORY: "Leonxlnx/Leonxlnx.github.io", LEGACY_FEED_APP_ID: "12345" },
      requiredEnvironmentSecrets: {
        "release-signing": ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"],
        "legacy-update-feed": ["LEGACY_FEED_APP_PRIVATE_KEY"],
      },
      requiredLegacyFeedApp: { installedOnlyOn: "Leonxlnx/Leonxlnx.github.io", permissions: { metadata: "read", contents: "write" } },
      missingAtCapture: [],
    },
    deferredGates: {
      repositoryProtections: {
        phase: "post-cutover-pre-release",
        sourceRepositoryId: 100,
        branch: "main",
        executorMustNotConfigureOrClaimCompletion: true,
        separatePolicyAndVerificationRequired: true,
        "blocksSignedV0.12Publication": true,
        blocksDesktopInstallation: true,
      },
    },
    execution: {
      stateMachineVersion: 1,
      journalPath: "artifacts/cutover-journal.json",
      resumePolicy: "Accept only exact journaled states; abort on every unjournaled value.",
      steps: [
        { id: "preflight", kind: "read-only", postcondition: "Local and remote evidence match." },
        { id: "user-site-main", kind: "exact-cas", repositoryId: 200, ref: "refs/heads/main", expectedOld: userSiteOld, approvedNew: userSite.commit },
        { id: "source-refs", kind: "atomic-source-refs", repositoryId: 100, includes: ["refs/heads/main", "refs/heads/gh-pages", "refs/tags/v0.8.3", "one exact branch deletions"] },
        { id: "rename", kind: "same-repository-rename", repositoryId: 100, expectedOld: "Leonxlnx/tasty-desktop", approvedNew: "Leonxlnx/kimi-code-desktop" },
        { id: "close-pull-requests", kind: "pinned-idempotent-pr-close", numbers: [17] },
        { id: "metadata-and-pages", kind: "exact-config", postcondition: "Pages settings match." },
        { id: "verify", kind: "read-only", postcondition: "Every postcondition matches." },
      ],
    },
    postconditions: {
      canonicalEndpoint: canonicalUrl,
      legacyEndpoint: legacyUrl,
      feedFiles: feedFiles.map(({ id: _id, ...file }) => ({ ...file })),
      releaseRecordAndAssetsUnchanged: true,
      oldRepositoryNameRemainsUnclaimed: true,
      "signedV0.12PublicationIsSeparate": true,
      desktopInstallationIsSeparate: true,
    },
    requiredBeforeMutation: [
      "Receive exactly APPROVE CLEAN-ROOT MIGRATION MANIFEST followed by the final lowercase SHA-256 of this frozen file from the repository owner.",
    ],
    forbidden: [
      "Do not push the local development repository or its private checkpoint refs.",
      "Do not use a plain force push or broaden a stale lease.",
      "Do not recreate Leonxlnx/tasty-desktop after the same repository is renamed.",
      "Do not delete or replace the v0.8.3 Release or its four uploaded assets.",
      "Do not install or restart the desktop app until a separate approval is given.",
    ],
  };

  const manifestPath = join(artifactRoot, "artifacts", "MIGRATION_APPROVAL.json");
  const options = {
    manifest: manifestPath,
    artifactRoot,
    sourceRepo: source.path,
    canonicalRepo: canonical.path,
    userSiteRepo: userSite.path,
    sanitizedV083Repo: sanitized.path,
  };
  const fixture = {
    root,
    artifactRoot,
    artifacts,
    repositories: { source, canonical, userSite, sanitized },
    manifest,
    options,
    writeManifest: async () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  };
  await fixture.writeManifest();
  return fixture;
}

async function createRepository(path, branch, contents) {
  await mkdir(path, { recursive: true });
  await git(["init", "--quiet", `--initial-branch=${branch}`], path);
  const commits = [];
  for (const [index, content] of contents.entries()) {
    await writeFile(join(path, "content.txt"), `${content}\n`);
    await git(["add", "content.txt"], path);
    await git(["commit", "--quiet", "-m", `fixture ${index + 1}`], path, {
      ...identityEnvironment,
      GIT_AUTHOR_DATE: `2026-08-08T12:0${index}:00.000Z`,
      GIT_COMMITTER_DATE: `2026-08-08T12:0${index}:00.000Z`,
    });
    commits.push((await git(["rev-parse", "HEAD"], path)).stdout.trim());
  }
  return {
    path,
    commits,
    commit: commits.at(-1),
    tree: (await git(["rev-parse", "HEAD^{tree}"], path)).stdout.trim(),
  };
}

function repositoryRecord(root, repository, branch, parent) {
  return {
    path: portableRelative(root, repository.path),
    branch,
    commit: repository.commit,
    tree: repository.tree,
    parent,
  };
}

async function artifactRecord(root, path, includeBytes = false) {
  const bytes = await readFile(path);
  return {
    path: portableRelative(root, path),
    ...(includeBytes ? { bytes: bytes.length } : {}),
    sha256: sha256(bytes),
  };
}

function portableRelative(root, path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}

function cliArguments(options) {
  return [
    "--manifest", options.manifest,
    "--artifact-root", options.artifactRoot,
    "--source-repo", options.sourceRepo,
    "--canonical-repo", options.canonicalRepo,
    "--user-site-repo", options.userSiteRepo,
    "--sanitized-v083-repo", options.sanitizedV083Repo,
  ];
}

async function git(args, cwd, extraEnvironment = {}) {
  const result = await execFileAsync("git", ["-c", `safe.directory=${resolve(cwd)}`, "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnvironment,
    },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "kimi-migration-approval-test-"));
  try {
    return await callback(await createFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
