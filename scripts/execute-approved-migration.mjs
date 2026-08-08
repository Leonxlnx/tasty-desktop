import { createHash, createPrivateKey, sign as signBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  constants as fsConstants,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  lstat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const OBJECT_ID = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const APPROVAL_PREFIX = "APPROVE CLEAN-ROOT MIGRATION MANIFEST ";
const SOURCE_REFS = Object.freeze({
  main: "refs/heads/main",
  pages: "refs/heads/gh-pages",
  tag: "refs/tags/v0.8.3",
});
const STEP_ORDER = Object.freeze([
  "preflight",
  "user-site-main",
  "source-refs",
  "rename",
  "close-pull-requests",
  "metadata-and-pages",
  "verify",
]);
const ACTIVE_WORKFLOW_STATUSES = Object.freeze(["queued", "in_progress", "waiting", "pending", "requested", "action_required"]);
const ALLOWED_LOCAL_GIT = new Set(["cat-file", "config", "fsck", "remote", "rev-list", "rev-parse", "show"]);
const ALLOWED_LOCAL_CONFIG = new Set([
  "core.bare",
  "core.autocrlf",
  "core.filemode",
  "core.ignorecase",
  "core.logallrefupdates",
  "core.repositoryformatversion",
  "core.safecrlf",
  "core.symlinks",
  "commit.gpgsign",
  "tag.gpgsign",
  "user.email",
  "user.name",
]);

function buildMutationSteps(manifest) {
  return Object.freeze([
    "user-site-main",
    "source-refs",
    "rename",
    ...manifest.sourceRepository.pullRequestsToClose.map((pull) => `close-pull-request:${pull.number}`),
    "configure-repository-metadata",
    "configure-repository-topics",
    "configure-source-pages",
    "configure-user-site-pages",
  ]);
}

function parsePullRequestStep(stepId) {
  const match = /^close-pull-request:([1-9][0-9]*)$/u.exec(stepId);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Invalid pull-request mutation step ${String(stepId)}`);
  return Number(match[1]);
}

export function validateManifest(manifest, options = {}) {
  assertPlainObject(manifest, "manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Migration manifest schemaVersion must be 1");
  if (manifest.approvalRequired !== true) throw new Error("Migration manifest must require approval");
  if (manifest.approvalFormat !== `${APPROVAL_PREFIX}<sha256-of-this-file>`) {
    throw new Error("Migration manifest has an unsupported approval format");
  }
  if (typeof manifest.approvalEligible !== "boolean") throw new Error("approvalEligible must be boolean");
  if (manifest.lastRemoteFreezeMatched !== true) throw new Error("The frozen remote snapshot did not match");

  const source = requiredObject(manifest, "sourceRepository");
  const userSite = requiredObject(manifest, "userSiteRepository");
  const release = requiredObject(manifest, "release");
  const local = requiredObject(manifest, "localEvidence");
  const prerequisites = requiredObject(manifest, "prerequisites");
  const execution = requiredObject(manifest, "execution");
  const postconditions = requiredObject(manifest, "postconditions");
  const deferredProtections = requiredObject(requiredObject(manifest, "deferredGates"), "repositoryProtections");
  const capturedInitialState = requiredObject(manifest, "capturedInitialState");

  assertPositiveInteger(source.repositoryId, "source repository ID");
  assertNonempty(source.nodeId, "source repository node ID");
  assertRepositoryName(source.currentName, "source current name");
  assertRepositoryName(source.approvedName, "source approved name");
  if (source.currentName === source.approvedName) throw new Error("Source repository rename must change the name");
  assertPositiveInteger(userSite.repositoryId, "user-site repository ID");
  assertNonempty(userSite.nodeId, "user-site repository node ID");
  assertRepositoryName(userSite.name, "user-site repository name");
  if (source.repositoryId === userSite.repositoryId || source.nodeId === userSite.nodeId) {
    throw new Error("Source and user-site repositories must have distinct pinned identities");
  }
  assertPagesContracts(manifest, source, userSite, postconditions, capturedInitialState);

  assertRefTransition(source.main, "source main", "replace-with-exact-force-with-lease");
  assertRefTransition(source.ghPages, "source gh-pages", "fast-forward-only");
  const tag = requiredObject(source, "v0.8.3");
  for (const key of ["expectedOldTagObject", "expectedOldCommit", "expectedOldTree", "approvedNewTagObject", "approvedNewCommit", "approvedNewTree"]) {
    assertObjectId(tag[key], `v0.8.3 ${key}`);
  }
  if (tag.action !== "retarget-with-exact-tag-lease-preserve-release") throw new Error("Unexpected v0.8.3 action");
  assertRefTransition(userSite.main, "user-site main", "replace-with-exact-force-with-lease");
  if (userSite.cname?.decision !== "omit") throw new Error("User-site CNAME decision must be omit");

  if (!Array.isArray(source.branches) || source.branches.length === 0) throw new Error("Pinned branch deletions are required");
  const branchNames = new Set();
  for (const branch of source.branches) {
    assertPlainObject(branch, "branch deletion");
    assertSafeBranch(branch.name);
    assertObjectId(branch.expectedOld, `branch ${branch.name} old object`);
    if (branch.action !== "lease-delete") throw new Error(`Unexpected action for branch ${branch.name}`);
    if (branchNames.has(branch.name)) throw new Error(`Duplicate branch ${branch.name}`);
    branchNames.add(branch.name);
  }

  if (!Array.isArray(source.pullRequestsToClose) || source.pullRequestsToClose.length !== source.branches.length) {
    throw new Error("Every pinned branch deletion must have one pinned pull request");
  }
  const prNumbers = new Set();
  const prHeads = new Set();
  for (const pull of source.pullRequestsToClose) {
    assertPositiveInteger(pull.number, "pull request number");
    assertNonempty(pull.nodeId, `pull request #${pull.number} node ID`);
    if (pull.state !== "open" || pull.baseRef !== "main" || pull.baseSha !== source.main.expectedOld) {
      throw new Error(`Pull request #${pull.number} is not pinned to the approved old main state`);
    }
    assertSafeBranch(pull.headRef);
    assertObjectId(pull.headSha, `pull request #${pull.number} head SHA`);
    const matchingBranch = source.branches.find((entry) => entry.name === pull.headRef);
    if (!matchingBranch || matchingBranch.expectedOld !== pull.headSha) {
      throw new Error(`Pull request #${pull.number} does not match its pinned branch`);
    }
    if (prNumbers.has(pull.number) || prHeads.has(pull.headRef)) throw new Error("Duplicate pinned pull request identity");
    prNumbers.add(pull.number);
    prHeads.add(pull.headRef);
  }

  assertPositiveInteger(release.id, "release ID");
  if (release.tag !== "v0.8.3" || release.preserveRecordAndAssets !== true || release.signatureVerified !== true) {
    throw new Error("The pinned v0.8.3 Release must be preserved and signature-verified");
  }
  assertSha256(release.signatureEvidenceSha256, "signature evidence SHA-256");
  if (!Array.isArray(release.assets) || release.assets.length !== 4) throw new Error("Exactly four v0.8.3 Release assets must be pinned");
  const assetIds = new Set();
  const assetNames = new Set();
  for (const asset of release.assets) {
    assertPositiveInteger(asset.id, "release asset ID");
    assertSafeFileName(asset.name, "release asset name");
    assertPositiveInteger(asset.bytes, `release asset ${asset.name} byte count`);
    assertSha256(asset.sha256, `release asset ${asset.name} SHA-256`);
    if (assetIds.has(asset.id) || assetNames.has(asset.name)) throw new Error("Duplicate release asset identity");
    assetIds.add(asset.id);
    assetNames.add(asset.name);
  }

  assertLocalEvidence(local, manifest);
  assertPrerequisiteContract(manifest, prerequisites, options);
  if (prerequisites.ready !== true && options.forApply === true) throw new Error("Migration prerequisites are not ready");
  if (options.forApply === true && manifest.approvalEligible !== true) throw new Error("Migration manifest is not approval-eligible");
  if (!Array.isArray(execution.steps) || execution.steps.map((step) => step.id).join("\0") !== STEP_ORDER.join("\0")) {
    throw new Error("Migration execution steps are not the approved state machine");
  }
  assertRelativePath(execution.journalPath, "journal path");
  if (execution.stateMachineVersion !== 1) throw new Error("Unsupported migration state machine version");
  if (postconditions.releaseRecordAndAssetsUnchanged !== true || postconditions["signedV0.12PublicationIsSeparate"] !== true || postconditions.desktopInstallationIsSeparate !== true) {
    throw new Error("Required release and installation separation is missing");
  }
  assertExactObjectKeys(deferredProtections, [
    "phase",
    "sourceRepositoryId",
    "branch",
    "executorMustNotConfigureOrClaimCompletion",
    "separatePolicyAndVerificationRequired",
    "blocksSignedV0.12Publication",
    "blocksDesktopInstallation",
  ], "deferred repository-protection gate");
  if (deferredProtections.phase !== "post-cutover-pre-release"
    || deferredProtections.sourceRepositoryId !== source.repositoryId
    || deferredProtections.branch !== "main"
    || deferredProtections.executorMustNotConfigureOrClaimCompletion !== true
    || deferredProtections.separatePolicyAndVerificationRequired !== true
    || deferredProtections["blocksSignedV0.12Publication"] !== true
    || deferredProtections.blocksDesktopInstallation !== true) {
    throw new Error("Repository protections must remain an explicit post-cutover, pre-release deferred gate");
  }
  assertHttpsUrl(postconditions.canonicalEndpoint, "canonical Pages endpoint");
  assertHttpsUrl(postconditions.legacyEndpoint, "legacy Pages endpoint");
  if (!Array.isArray(postconditions.feedFiles) || postconditions.feedFiles.length !== release.assets.length) {
    throw new Error("Postcondition feed files must pin every Release asset");
  }
  for (const expected of postconditions.feedFiles) {
    const asset = release.assets.find((entry) => entry.name === expected.name);
    if (!asset || asset.bytes !== expected.bytes || asset.sha256 !== expected.sha256) {
      throw new Error(`Postcondition bytes differ from Release asset ${expected.name}`);
    }
  }
  return manifest;
}

export function expectedApprovalBytes(manifestSha256) {
  assertSha256(manifestSha256, "manifest SHA-256");
  return Buffer.from(`${APPROVAL_PREFIX}${manifestSha256}\n`, "utf8");
}

export function classifyState(manifest, snapshot) {
  validateManifest(manifest);
  assertPlainObject(snapshot, "remote snapshot");
  assertPinnedRepository(snapshot.sourceRepository, manifest.sourceRepository, "source");
  assertPinnedRepository(snapshot.userSiteRepository, manifest.userSiteRepository, "user-site");
  assertPinnedRelease(snapshot.sourceRepository.release, manifest.release);
  assertPinnedPullRequests(snapshot.sourceRepository.pullRequests, manifest.sourceRepository.pullRequestsToClose, manifest.sourceRepository.main.approvedNew);

  const userTip = snapshot.userSiteRepository.refs?.[SOURCE_REFS.main] ?? null;
  const userState = exactOldOrNew(userTip, manifest.userSiteRepository.main.expectedOld, manifest.userSiteRepository.main.approvedNew, "user-site main");
  const sourceRefs = snapshot.sourceRepository.refs ?? {};
  const sourceStatuses = [
    exactOldOrNew(sourceRefs[SOURCE_REFS.main] ?? null, manifest.sourceRepository.main.expectedOld, manifest.sourceRepository.main.approvedNew, "source main"),
    exactOldOrNew(sourceRefs[SOURCE_REFS.pages] ?? null, manifest.sourceRepository.ghPages.expectedOld, manifest.sourceRepository.ghPages.approvedNew, "source gh-pages"),
    exactOldOrNew(sourceRefs[SOURCE_REFS.tag] ?? null, manifest.sourceRepository["v0.8.3"].expectedOldTagObject, manifest.sourceRepository["v0.8.3"].approvedNewTagObject, "source v0.8.3 tag"),
    ...manifest.sourceRepository.branches.map((branch) => {
      const value = sourceRefs[`refs/heads/${branch.name}`] ?? null;
      if (value === branch.expectedOld) return "old";
      if (value === null) return "new";
      throw new Error(`Unapproved remote value for branch ${branch.name}: ${String(value)}`);
    }),
  ];
  if (!sourceStatuses.every((value) => value === sourceStatuses[0])) {
    throw new Error("Source refs are in an unapproved non-atomic mixed state");
  }
  const sourceState = sourceStatuses[0];
  assertOrdinaryRefInventory(snapshot.sourceRepository, manifest, sourceState);
  const sourceName = snapshot.sourceRepository.name;
  const renameState = sourceName === manifest.sourceRepository.currentName
    ? "old"
    : sourceName === manifest.sourceRepository.approvedName
      ? "new"
      : fail(`Source repository has unapproved name ${String(sourceName)}`);

  const prStates = snapshot.sourceRepository.pullRequests.map((pull) => pull.state);
  const openPullRequests = snapshot.sourceRepository.pullRequests
    .filter((pull) => pull.state === "open")
    .map((pull) => pull.number)
    .sort((left, right) => left - right);
  if (prStates.some((state) => state !== "open" && state !== "closed")) throw new Error("Pinned pull request has an unsupported state");
  assertOpenPullRequestInventory(snapshot.sourceRepository.openPullRequests, snapshot.sourceRepository.pullRequests, manifest.sourceRepository.pullRequestsToClose);

  if (sourceState === "old" && userState === "new") {
    // This is the first documented forward-only prefix.
  } else if (sourceState === "new" && userState !== "new") {
    throw new Error("Source refs changed before the user-site compare-and-swap");
  }
  if (renameState === "new" && sourceState !== "new") throw new Error("Repository renamed before exact source refs were installed");
  if (openPullRequests.length !== manifest.sourceRepository.pullRequestsToClose.length && sourceState !== "new") {
    throw new Error("Pull requests changed before the atomic source-ref transition");
  }

  const metadataComponents = classifyMetadataComponents(manifest, snapshot);
  const metadata = Object.values(metadataComponents).every(Boolean);
  const pageBytes = pagesBytesMatch(manifest, snapshot.pages);
  const redirect = renameState === "new"
    ? snapshot.oldSlugRepositoryId === manifest.sourceRepository.repositoryId
    : snapshot.oldSlugRepositoryId === null || snapshot.oldSlugRepositoryId === manifest.sourceRepository.repositoryId;
  if (renameState === "new" && !redirect) throw new Error("Old source slug does not redirect to the pinned repository ID");
  const complete = userState === "new"
    && sourceState === "new"
    && renameState === "new"
    && openPullRequests.length === 0
    && metadata
    && pageBytes
    && redirect;
  return Object.freeze({
    userSite: userState,
    sourceRefs: sourceState,
    rename: renameState,
    openPullRequests,
    metadata,
    ...metadataComponents,
    pageBytes,
    redirect,
    complete,
  });
}

export function buildPlan(manifest, state) {
  validateManifest(manifest);
  assertPlainObject(state, "classified state");
  const steps = [{ id: "preflight", mutation: false }];
  if (state.userSite === "old") steps.push({ id: "user-site-main", mutation: true });
  if (state.sourceRefs === "old") steps.push({ id: "source-refs", mutation: true });
  if (state.rename === "old") steps.push({ id: "rename", mutation: true });
  if (state.openPullRequests.length > 0) {
    steps.push({ id: "close-pull-requests", mutation: true, numbers: [...state.openPullRequests] });
  }
  if (!state.metadata) steps.push({ id: "metadata-and-pages", mutation: true });
  steps.push({ id: "verify", mutation: false });
  return Object.freeze({ verificationOnly: state.complete, steps: Object.freeze(steps.map(Object.freeze)) });
}

export function buildUserSitePush(manifest) {
  validateManifest(manifest);
  return Object.freeze({
    kind: "user-site",
    repository: manifest.userSiteRepository.name,
    atomic: false,
    leases: Object.freeze([{ ref: SOURCE_REFS.main, expected: manifest.userSiteRepository.main.expectedOld }]),
    updates: Object.freeze([{ source: manifest.userSiteRepository.main.approvedNew, destination: SOURCE_REFS.main }]),
  });
}

export function buildSourcePush(manifest) {
  validateManifest(manifest);
  const source = manifest.sourceRepository;
  const leases = [
    { ref: SOURCE_REFS.main, expected: source.main.expectedOld },
    { ref: SOURCE_REFS.pages, expected: source.ghPages.expectedOld },
    { ref: SOURCE_REFS.tag, expected: source["v0.8.3"].expectedOldTagObject },
    ...source.branches.map((branch) => ({ ref: `refs/heads/${branch.name}`, expected: branch.expectedOld })),
  ];
  const updates = [
    { source: source.main.approvedNew, destination: SOURCE_REFS.main },
    { source: source.ghPages.approvedNew, destination: SOURCE_REFS.pages },
    { source: source["v0.8.3"].approvedNewTagObject, destination: SOURCE_REFS.tag },
    ...source.branches.map((branch) => ({ source: null, destination: `refs/heads/${branch.name}` })),
  ];
  return Object.freeze({
    kind: "source",
    repository: source.currentName,
    atomic: true,
    leases: Object.freeze(leases.map(Object.freeze)),
    updates: Object.freeze(updates.map(Object.freeze)),
  });
}

export function assertPushSafety(push, manifest) {
  validateManifest(manifest);
  assertPlainObject(push, "push specification");
  const expected = push.kind === "source" ? buildSourcePush(manifest) : push.kind === "user-site" ? buildUserSitePush(manifest) : null;
  if (!expected || canonicalJson(push) !== canonicalJson(expected)) throw new Error("Push specification is not the exact approved operation");
  if (push.kind === "source" && push.atomic !== true) throw new Error("Source ref migration must be one atomic push");
  if (push.kind === "user-site" && push.atomic !== false) throw new Error("User-site migration must be one exact single-ref CAS");
  for (const lease of push.leases) {
    assertFullRef(lease.ref);
    assertObjectId(lease.expected, `lease for ${lease.ref}`);
  }
  for (const update of push.updates) {
    assertFullRef(update.destination);
    if (update.source !== null) assertObjectId(update.source, `source object for ${update.destination}`);
  }
  const refs = push.leases.map((entry) => entry.ref);
  if (new Set(refs).size !== refs.length || push.updates.length !== push.leases.length) throw new Error("Every pushed ref requires one explicit unique lease");
  for (const update of push.updates) {
    if (!refs.includes(update.destination)) throw new Error(`Missing explicit lease for ${update.destination}`);
  }
  return push;
}

export function pushCommand(push, manifest) {
  assertPushSafety(push, manifest);
  const args = ["-c", "credential.interactive=never", "-c", "protocol.version=2", "push", "--porcelain", "--no-verify"];
  if (push.atomic) args.push("--atomic");
  for (const lease of push.leases) args.push(`--force-with-lease=${lease.ref}:${lease.expected}`);
  args.push(`https://github.com/${push.repository}.git`);
  for (const update of push.updates) args.push(`${update.source ?? ""}:${update.destination}`);
  assertNoBroadPushArguments(args);
  return Object.freeze({
    capability: push.kind === "source" ? "git.push-source-atomic" : "git.push-user-site-cas",
    executable: "git",
    args: Object.freeze(args),
  });
}

export async function loadLegacyFeedAppAuthentication({
  privateKeyPath,
  workspaceRoot,
  appId,
  clock = () => new Date().toISOString(),
  fileSystem = { lstat, open, realpath, stat },
}) {
  assertPositiveInteger(appId, "legacy-feed GitHub App ID");
  if (typeof privateKeyPath !== "string" || !isAbsolute(privateKeyPath) || privateKeyPath.includes("\0")) {
    throw new Error("Legacy-feed App authentication requires an explicit absolute --legacy-feed-app-private-key path");
  }
  const keyPath = resolve(privateKeyPath);
  const root = resolve(workspaceRoot);
  const fromWorkspace = relative(root, keyPath);
  if (!isAbsolute(fromWorkspace) && !fromWorkspace.startsWith(`..${sep}`) && fromWorkspace !== "..") {
    throw new Error("Legacy-feed App private key must remain outside the development workspace");
  }
  let canonicalParent;
  try { canonicalParent = resolve(await fileSystem.realpath(dirname(keyPath))); } catch { throw new Error("Legacy-feed App private key parent path cannot be resolved safely"); }
  if (!sameFilesystemPath(canonicalParent, dirname(keyPath))) throw new Error("Legacy-feed App private key parent path may not traverse a symlink");
  let handle;
  try {
    handle = await fileSystem.open(keyPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Legacy-feed App private key is missing, unreadable, or a symlink");
  }
  let pem;
  try {
    const openedBefore = await handle.stat({ bigint: true });
    const pathLink = await fileSystem.lstat(keyPath, { bigint: true });
    if (!openedBefore?.isFile?.() || pathLink?.isSymbolicLink?.() || !pathLink?.isFile?.()) {
      throw new Error("Legacy-feed App private key must be a regular non-symlink file");
    }
    const pathInfo = await fileSystem.stat(keyPath, { bigint: true });
    if (!sameFileIdentity(openedBefore, pathInfo)) throw new Error("Legacy-feed App private key changed while it was being opened");
    const canonicalPath = resolve(await fileSystem.realpath(keyPath));
    if (!sameFilesystemPath(canonicalPath, keyPath)) throw new Error("Legacy-feed App private key path may not traverse a symlink");
    pem = Buffer.from(await handle.readFile());
    const openedAfter = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(openedBefore, openedAfter)) throw new Error("Legacy-feed App private key changed while it was being read");
  } finally {
    await handle.close();
  }
  if (pem.length < 256 || pem.length > 32 * 1024 || pem.includes(0)) {
    pem.fill(0);
    throw new Error("Legacy-feed App private key has an invalid bounded PEM representation");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error("Legacy-feed App private key is not a valid private key");
  } finally {
    pem.fill(0);
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("Legacy-feed App private key must be an RSA private key for RS256");
  }
  return Object.freeze({
    appId,
    createJwt() {
      const now = Date.parse(clock());
      if (!Number.isFinite(now)) throw new Error("Legacy-feed App JWT clock is invalid");
      const issuedAt = Math.floor(now / 1000) - 30;
      const expiresAt = issuedAt + (9 * 60);
      const header = Buffer.from(canonicalJson({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
      const payload = Buffer.from(canonicalJson({ exp: expiresAt, iat: issuedAt, iss: String(appId) }), "utf8").toString("base64url");
      const unsigned = `${header}.${payload}`;
      const signature = signBytes("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url");
      return `${unsigned}.${signature}`;
    },
  });
}

function sameFilesystemPath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function createMigrationExecutor(dependencies = {}) {
  const command = dependencies.command ?? createCommandAdapter();
  const fetchAdapter = dependencies.fetch ?? createFetchAdapter(command);
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const journal = dependencies.journal ?? createFileJournalAdapter();
  const inspectRemote = dependencies.inspectRemote ?? ((context) => inspectGitHubRemote(context, fetchAdapter));
  const verifyLocalEvidence = dependencies.verifyLocalEvidence ?? defaultVerifyLocalEvidence;
  const afterMutation = dependencies.afterMutation ?? (() => undefined);
  const loadAppAuthentication = dependencies.loadLegacyFeedAppAuthentication ?? loadLegacyFeedAppAuthentication;
  const usesDefaultRemoteInspector = dependencies.inspectRemote === undefined;

  return Object.freeze({
    async run(input = {}) {
      const mode = input.mode ?? "verify";
      if (!new Set(["verify", "plan", "apply"]).has(mode)) throw new Error(`Unsupported executor mode ${String(mode)}`);
      const manifestPath = resolve(input.manifestPath ?? "dist/migration/2026-08-08/MIGRATION_APPROVAL.json");
      const manifestBytes = input.manifestBytes ? Buffer.from(input.manifestBytes) : await readFile(manifestPath);
      assertCanonicalManifestBytes(manifestBytes);
      const manifestSha256 = sha256(manifestBytes);
      if (input.expectedManifestSha256 !== undefined) {
        assertSha256(input.expectedManifestSha256, "expected manifest SHA-256");
        if (input.expectedManifestSha256 !== manifestSha256) throw new Error("Migration manifest SHA-256 does not match --expected-manifest-sha256");
      }
      const manifest = JSON.parse(manifestBytes.toString("utf8"));

      if (mode === "apply") {
        if (!input.expectedManifestSha256) throw new Error("Apply requires --expected-manifest-sha256");
        const approvalBytes = input.approvalBytes
          ? Buffer.from(input.approvalBytes)
          : input.approvalFile
            ? await readFile(resolve(input.approvalFile))
            : fail("Apply requires --approval-file");
        if (!approvalBytes.equals(expectedApprovalBytes(manifestSha256))) {
          throw new Error("Approval file contents are not the exact approved manifest phrase followed by one LF");
        }
        if (input.recoverStaleLockSha256 !== undefined) assertSha256(input.recoverStaleLockSha256, "stale lock recovery SHA-256");
      }
      validateManifest(manifest, { forApply: mode === "apply" });
      const workspaceRoot = resolve(input.workspaceRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
      const requiredAppId = Number(manifest.prerequisites.requiredVariables.LEGACY_FEED_APP_ID);
      const appAuthentication = usesDefaultRemoteInspector
        ? dependencies.legacyFeedAppAuthentication ?? await loadAppAuthentication({
          privateKeyPath: input.legacyFeedAppPrivateKeyPath,
          workspaceRoot,
          appId: requiredAppId,
          clock,
        })
        : dependencies.legacyFeedAppAuthentication ?? null;
      await verifyLocalEvidence({ manifest, manifestPath, manifestSha256, workspaceRoot, command });
      const context = { manifest, manifestSha256, workspaceRoot, command, fetch: fetchAdapter, appAuthentication, clock };
      let snapshot = await inspectRemote(context);
      assertRemotePrerequisites(manifest, snapshot, mode === "apply");
      let state = classifyState(manifest, snapshot);
      let plan = buildPlan(manifest, state);

      if (mode !== "apply" && plan.steps.every((step) => !step.mutation)) {
        const pages = await verifyPages(context, fetchAdapter, sleep);
        snapshot = { ...snapshot, pages };
        state = classifyState(manifest, snapshot);
        plan = buildPlan(manifest, state);
        return { mode, manifestSha256, state, plan, pages, verificationOnly: plan.verificationOnly };
      }

      if (mode !== "apply") return { mode, manifestSha256, state, plan };

      const journalPath = resolve(workspaceRoot, manifest.execution.journalPath);
      assertWithin(workspaceRoot, journalPath, "journal path");
      return journal.withExclusive(journalPath, manifestSha256, clock, async (log) => {
        const mutationSteps = buildMutationSteps(manifest);
        snapshot = await inspectRemote(context);
        assertRemotePrerequisites(manifest, snapshot, true);
        state = classifyState(manifest, snapshot);
        let proof = validateJournalPrefix(manifest, log.records, state);
        if (proof.recoverStep) {
          await log.append("step-recovered", { id: proof.recoverStep, state });
          proof = { ...proof, completedCount: proof.completedCount + 1, pendingStep: null, recoverStep: null, provenState: durableState(state) };
        }

        if (proof.completedCount < mutationSteps.length) {
          const authentication = await runAllowedCommand(command, {
            capability: "github.auth-token",
            executable: "gh",
            args: ["auth", "token"],
            cwd: workspaceRoot,
          }, {});
          if (!authentication.stdout.trim() || /[\r\n]/u.test(authentication.stdout.trim())) throw new Error("GitHub authentication token is unavailable or invalid");
        }

        for (let index = proof.completedCount; index < mutationSteps.length; index += 1) {
          const stepId = mutationSteps[index];
          snapshot = await inspectRemote(context);
          assertRemotePrerequisites(manifest, snapshot, true);
          state = classifyState(manifest, snapshot);
          assertDurableStateEquals(state, proof.provenState, `remote changed before ${stepId}`);
          const alreadyStarted = proof.pendingStep === stepId;
          if (!alreadyStarted) await log.append("step-started", { id: stepId });
          const step = stepForState(stepId, state);
          if (stepPostconditionSatisfied(stepId, state)) {
            await log.append("step-recovered", { id: stepId, state });
            proof = { ...proof, completedCount: index + 1, pendingStep: null, provenState: durableState(state) };
            continue;
          }
          await executeStep(step, context, dependencies, command, fetchAdapter);
          await afterMutation({ step: stepId, context });
          snapshot = await inspectRemote(context);
          assertRemotePrerequisites(manifest, snapshot, true);
          const nextState = classifyState(manifest, snapshot);
          assertStepAdvanced(stepId, state, nextState);
          state = nextState;
          await log.append("step-completed", { id: stepId, state });
          proof = { ...proof, completedCount: index + 1, pendingStep: null, provenState: durableState(state) };
        }
        const pages = await verifyPages(context, fetchAdapter, sleep);
        snapshot = await inspectRemote(context);
        assertRemotePrerequisites(manifest, snapshot, true);
        state = classifyState(manifest, { ...snapshot, pages });
        if (!state.complete) throw new Error("Migration postconditions are not completely verified");
        if (!proof.verified) await log.append("run-verified", { state, pages });
        return { mode, manifestSha256, state, plan: buildPlan(manifest, state), pages, verificationOnly: proof.verified };
      }, { recoverStaleLockSha256: input.recoverStaleLockSha256 });
    },
  });
}

export function validateJournalPrefix(manifest, records, liveState) {
  validateManifest(manifest);
  if (!Array.isArray(records)) throw new Error("Migration journal records must be an array");
  const mutationSteps = buildMutationSteps(manifest);
  let completedCount = 0;
  let pendingStep = null;
  let verified = false;
  let provenState = approvedOldDurableState(manifest);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertPlainObject(record, `migration journal record ${index}`);
    if (verified) throw new Error("Migration journal contains records after run-verified");
    if (record.event === "step-started") {
      if (pendingStep !== null || completedCount >= mutationSteps.length) throw new Error("Migration journal has an out-of-order step-started record");
      assertExactPayloadKeys(record.payload, ["id"], "step-started");
      const expectedStep = mutationSteps[completedCount];
      if (record.payload.id !== expectedStep) throw new Error(`Migration journal starts ${record.payload.id} before ${expectedStep}`);
      pendingStep = expectedStep;
      continue;
    }
    if (record.event === "step-completed" || record.event === "step-recovered") {
      assertExactPayloadKeys(record.payload, ["id", "state"], record.event);
      if (pendingStep === null || record.payload.id !== pendingStep) throw new Error(`Migration journal ${record.event} has no matching terminal step-started`);
      const recordedState = durableState(record.payload.state);
      assertStepTransition(pendingStep, provenState, recordedState, `journal ${record.event}`);
      provenState = recordedState;
      completedCount += 1;
      pendingStep = null;
      continue;
    }
    if (record.event === "run-verified") {
      assertExactPayloadKeys(record.payload, ["pages", "state"], "run-verified");
      if (pendingStep !== null || completedCount !== mutationSteps.length || record.payload.state?.complete !== true) {
        throw new Error("Migration journal run-verified appears before the complete mutation prefix");
      }
      assertDurableStateEquals(record.payload.state, provenState, "run-verified state differs from proven prefix");
      verified = true;
      continue;
    }
    throw new Error(`Migration journal event is not allowed: ${String(record.event)}`);
  }

  const observed = durableState(liveState);
  if (pendingStep === null) {
    assertDurableStateEquals(observed, provenState, records.length === 0 ? "empty journal accepts only the complete approved-old state" : "remote is not the exact journal-proven prefix");
    return { completedCount, pendingStep: null, recoverStep: null, provenState, verified };
  }
  if (canonicalJson(observed) === canonicalJson(provenState)) {
    return { completedCount, pendingStep, recoverStep: null, provenState, verified };
  }
  assertStepTransition(pendingStep, provenState, observed, "terminal step recovery");
  return { completedCount, pendingStep, recoverStep: pendingStep, provenState, verified };
}

function approvedOldDurableState(manifest) {
  const captured = manifest.capturedInitialState;
  const initialComponents = {
    repositoryMetadata: metadataIdentity(captured.sourceRepository.metadata),
    repositoryTopics: normalizedTopics(captured.sourceRepository.metadata.topics),
    sourcePages: captured.sourceRepository.pages,
    userSitePages: captured.userSiteRepository.pages,
  };
  const desiredComponents = {
    repositoryMetadata: metadataIdentity(manifest.sourceRepository.desiredMetadata),
    repositoryTopics: normalizedTopics(manifest.sourceRepository.desiredMetadata.topics),
    sourcePages: manifest.sourceRepository.desiredPages,
    userSitePages: manifest.userSiteRepository.desiredPages,
  };
  const componentState = Object.fromEntries(Object.keys(initialComponents).map((key) => [
    key,
    canonicalJson(initialComponents[key]) === canonicalJson(desiredComponents[key]),
  ]));
  return {
    userSite: "old",
    sourceRefs: "old",
    rename: "old",
    openPullRequests: manifest.sourceRepository.pullRequestsToClose.map((pull) => pull.number).sort((a, b) => a - b),
    metadata: Object.values(componentState).every(Boolean),
    ...componentState,
    redirect: true,
  };
}

function durableState(state) {
  assertPlainObject(state, "classified migration state");
  if (!["old", "new"].includes(state.userSite) || !["old", "new"].includes(state.sourceRefs) || !["old", "new"].includes(state.rename)) {
    throw new Error("Classified migration state has invalid ref phases");
  }
  if (!Array.isArray(state.openPullRequests) || state.openPullRequests.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error("Classified migration state has invalid open pull requests");
  }
  if (new Set(state.openPullRequests).size !== state.openPullRequests.length) throw new Error("Classified migration state duplicates an open pull request");
  const booleanFlags = ["metadata", "repositoryMetadata", "repositoryTopics", "sourcePages", "userSitePages", "redirect"];
  if (booleanFlags.some((key) => typeof state[key] !== "boolean")) throw new Error("Classified migration state has invalid durable flags");
  if (state.metadata !== [state.repositoryMetadata, state.repositoryTopics, state.sourcePages, state.userSitePages].every(Boolean)) {
    throw new Error("Classified migration metadata aggregate is inconsistent");
  }
  return {
    userSite: state.userSite,
    sourceRefs: state.sourceRefs,
    rename: state.rename,
    openPullRequests: [...state.openPullRequests].sort((a, b) => a - b),
    metadata: state.metadata,
    repositoryMetadata: state.repositoryMetadata,
    repositoryTopics: state.repositoryTopics,
    sourcePages: state.sourcePages,
    userSitePages: state.userSitePages,
    redirect: state.redirect,
  };
}

function assertDurableStateEquals(actual, expected, label) {
  const observed = actual?.pageBytes === undefined && actual?.complete === undefined && Object.keys(actual ?? {}).length === 6
    ? actual
    : durableState(actual);
  if (canonicalJson(observed) !== canonicalJson(expected)) throw new Error(label);
}

function assertStepTransition(stepId, before, after, label) {
  const expected = structuredClone(before);
  switch (stepId) {
    case "user-site-main":
      if (before.userSite !== "old") throw new Error(`${label}: user-site step did not start old`);
      expected.userSite = "new";
      break;
    case "source-refs":
      if (before.sourceRefs !== "old") throw new Error(`${label}: source-ref step did not start old`);
      expected.sourceRefs = "new";
      if (!after.openPullRequests.every((number) => before.openPullRequests.includes(number))) throw new Error(`${label}: source transition introduced an open pull request`);
      expected.openPullRequests = [...after.openPullRequests];
      break;
    case "rename":
      if (before.rename !== "old") throw new Error(`${label}: rename step did not start old`);
      expected.rename = "new";
      expected.redirect = true;
      break;
    case "configure-repository-metadata":
      if (before.repositoryMetadata === false) expected.repositoryMetadata = true;
      else if (after.repositoryMetadata !== true) throw new Error(`${label}: exact repository metadata regressed`);
      break;
    case "configure-repository-topics":
      if (before.repositoryTopics === false) expected.repositoryTopics = true;
      else if (after.repositoryTopics !== true) throw new Error(`${label}: exact repository topics regressed`);
      break;
    case "configure-source-pages":
      if (before.sourcePages === false) expected.sourcePages = true;
      else if (after.sourcePages !== true) throw new Error(`${label}: exact source Pages configuration regressed`);
      break;
    case "configure-user-site-pages":
      if (before.userSitePages === false) expected.userSitePages = true;
      else if (after.userSitePages !== true) throw new Error(`${label}: exact user-site Pages configuration regressed`);
      break;
    default:
      if (stepId.startsWith("close-pull-request:")) {
        const number = parsePullRequestStep(stepId);
        if (before.openPullRequests.includes(number)) {
          expected.openPullRequests = before.openPullRequests.filter((entry) => entry !== number);
        } else if (after.openPullRequests.includes(number)) {
          throw new Error(`${label}: pull request #${number} reopened during its recovered no-op step`);
        }
        break;
      }
      throw new Error(`${label}: unsupported step ${String(stepId)}`);
  }
  expected.metadata = [expected.repositoryMetadata, expected.repositoryTopics, expected.sourcePages, expected.userSitePages].every(Boolean);
  if (canonicalJson(after) !== canonicalJson(expected)) throw new Error(`${label}: remote state changed outside ${stepId}`);
}

function assertExactPayloadKeys(payload, keys, label) {
  assertPlainObject(payload, `${label} payload`);
  if (Object.keys(payload).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} payload has unexpected fields`);
}

function stepPostconditionSatisfied(stepId, state) {
  if (stepId === "user-site-main") return state.userSite === "new";
  if (stepId === "source-refs") return state.sourceRefs === "new";
  if (stepId === "rename") return state.rename === "new" && state.redirect;
  if (stepId.startsWith("close-pull-request:")) return !state.openPullRequests.includes(parsePullRequestStep(stepId));
  if (stepId === "configure-repository-metadata") return state.repositoryMetadata;
  if (stepId === "configure-repository-topics") return state.repositoryTopics;
  if (stepId === "configure-source-pages") return state.sourcePages;
  if (stepId === "configure-user-site-pages") return state.userSitePages;
  throw new Error(`Unsupported migration step ${stepId}`);
}

function stepForState(stepId, state) {
  return { id: stepId, mutation: !stepPostconditionSatisfied(stepId, state) };
}

async function executeStep(step, context, dependencies, command, fetchAdapter) {
  const { manifest, workspaceRoot } = context;
  switch (step.id) {
    case "user-site-main": {
      const sourcePath = isolatedRepositoryPath(workspaceRoot, manifest.localEvidence.repositories.userSite.path);
      const temporary = await mkdtemp(join(tmpdir(), "kimi-approved-user-site-"));
      const repository = join(temporary, "objects.git");
      try {
        await runAllowedCommand(command, {
          capability: "git.execution-init",
          executable: "git",
          args: ["init", "--bare", "--quiet", repository],
          cwd: temporary,
        }, { manifest, workspaceRoot, temporary });
        await runAllowedCommand(command, {
          capability: "git.execution-import",
          executable: "git",
          args: ["-c", "protocol.version=2", "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", sourcePath, "refs/heads/main:refs/migration/user-site-main"],
          cwd: repository,
          expectedObject: manifest.userSiteRepository.main.approvedNew,
          importedRef: "refs/migration/user-site-main",
        }, { manifest, workspaceRoot, temporary });
        const observed = (await runAllowedCommand(command, localGitSpec(repository, ["rev-parse", "--verify", "refs/migration/user-site-main"]), { workspaceRoot })).stdout.trim();
        if (observed !== manifest.userSiteRepository.main.approvedNew) throw new Error("Imported object mismatch for user-site main");
        const spec = { ...pushCommand(buildUserSitePush(manifest), manifest), cwd: repository };
        await runAllowedCommand(command, spec, { manifest, workspaceRoot, temporary });
      } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
      return;
    }
    case "source-refs": {
      const temporary = await mkdtemp(join(tmpdir(), "kimi-approved-migration-"));
      const repository = join(temporary, "objects.git");
      try {
        await runAllowedCommand(command, {
          capability: "git.execution-init",
          executable: "git",
          args: ["init", "--bare", "--quiet", repository],
          cwd: temporary,
        }, { manifest, workspaceRoot, temporary });
        const inputs = [
          ["source-main", manifest.localEvidence.repositories.sourceRoot.path, "refs/heads/main", manifest.sourceRepository.main.approvedNew],
          ["source-pages", manifest.localEvidence.repositories.canonicalGhPages.path, "refs/heads/gh-pages", manifest.sourceRepository.ghPages.approvedNew],
          ["source-tag", manifest.localEvidence.repositories["sanitizedV0.8.3"].path, "refs/tags/v0.8.3", manifest.sourceRepository["v0.8.3"].approvedNewTagObject],
        ];
        for (const [name, relativePath, sourceRef, object] of inputs) {
          const sourcePath = isolatedRepositoryPath(workspaceRoot, relativePath);
          await runAllowedCommand(command, {
            capability: "git.execution-import",
            executable: "git",
            args: ["-c", "protocol.version=2", "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", sourcePath, `${sourceRef}:refs/migration/${name}`],
            cwd: repository,
            expectedObject: object,
            importedRef: `refs/migration/${name}`,
          }, { manifest, workspaceRoot, temporary });
          const observed = (await runAllowedCommand(command, localGitSpec(repository, ["rev-parse", "--verify", `refs/migration/${name}`]), { workspaceRoot })).stdout.trim();
          if (observed !== object) throw new Error(`Imported object mismatch for ${name}`);
        }
        const spec = { ...pushCommand(buildSourcePush(manifest), manifest), cwd: repository };
        await runAllowedCommand(command, spec, { manifest, workspaceRoot, temporary });
      } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
      return;
    }
    case "rename": {
      const target = manifest.sourceRepository.currentName;
      await apiMutation(fetchAdapter, context, "github.rename-repository", target, "PATCH", "", {
        name: manifest.sourceRepository.approvedName.split("/")[1],
      });
      return;
    }
    default: {
      if (!step.id.startsWith("close-pull-request:")) break;
      const repository = manifest.sourceRepository.approvedName;
      const byNumber = new Map(manifest.sourceRepository.pullRequestsToClose.map((pull) => [pull.number, pull]));
      const number = parsePullRequestStep(step.id);
      if (!byNumber.has(number)) throw new Error(`Unapproved pull request closure #${number}`);
      await apiMutation(fetchAdapter, context, "github.close-pull-request", repository, "PATCH", `/pulls/${number}`, { state: "closed" });
      return;
    }
    case "configure-repository-metadata": {
      const source = manifest.sourceRepository;
      const desired = source.desiredMetadata;
      await apiMutation(fetchAdapter, context, "github.configure-repository", source.approvedName, "PATCH", "", {
        description: desired.description,
        homepage: desired.homepage,
      });
      return;
    }
    case "configure-repository-topics": {
      const source = manifest.sourceRepository;
      const desired = source.desiredMetadata;
      await apiMutation(fetchAdapter, context, "github.configure-topics", source.approvedName, "PUT", "/topics", { names: desired.topics });
      return;
    }
    case "configure-source-pages": {
      const source = manifest.sourceRepository;
      await apiMutation(fetchAdapter, context, "github.configure-pages", source.approvedName, "PUT", "/pages", {
        build_type: "workflow",
        cname: null,
        https_enforced: true,
      });
      return;
    }
    case "configure-user-site-pages": {
      const userPages = manifest.userSiteRepository.desiredPages;
      await apiMutation(fetchAdapter, context, "github.configure-pages", manifest.userSiteRepository.name, "PUT", "/pages", {
        build_type: "legacy",
        source: userPages.source,
        cname: null,
        https_enforced: true,
      });
      return;
    }
  }
  throw new Error(`Unsupported mutating step ${step.id}`);
}

function assertStepAdvanced(step, before, after) {
  assertStepTransition(step, durableState(before), durableState(after), `step ${step}`);
}

export function createFileJournalAdapter() {
  return Object.freeze({
    async withExclusive(path, manifestSha256, clock, callback, options = {}) {
      assertSha256(manifestSha256, "journal manifest SHA-256");
      await mkdir(dirname(path), { recursive: true });
      const lockPath = `${path}.lock`;
      let lock;
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code === "EEXIST") {
          const staleBytes = await readFile(lockPath);
          const staleHash = sha256(staleBytes);
          if (options.recoverStaleLockSha256 !== staleHash) {
            throw new Error(`Migration journal lock exists. If its recorded PID is dead, resume only with --recover-stale-lock-sha256 ${staleHash}`);
          }
          const owner = parseStaleLock(staleBytes, manifestSha256, clock());
          if (isProcessAlive(owner.pid)) throw new Error(`Migration journal is actively held by PID ${owner.pid}`);
          const recoveredPath = `${lockPath}.recovered-${staleHash}`;
          try { await access(recoveredPath); throw new Error(`Recovered lock evidence already exists: ${recoveredPath}`); } catch (recoveryError) {
            if (recoveryError?.code !== "ENOENT") throw recoveryError;
          }
          await rename(lockPath, recoveredPath);
          const recoveredBytes = await readFile(recoveredPath);
          if (!recoveredBytes.equals(staleBytes)) throw new Error("Stale lock changed during audited recovery");
          lock = await open(lockPath, "wx", 0o600);
        } else {
          throw error;
        }
      }
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid, host: hostname(), manifestSha256, openedAt: clock() })}\n`);
        await lock.sync();
        const records = await loadJournal(path, manifestSha256);
        let previousHash = records.at(-1)?.hash ?? "0".repeat(64);
        let sequence = records.length;
        const append = async (event, payload) => {
          assertNonempty(event, "journal event");
          const unsigned = { sequence, at: clock(), event, payload, previousHash, manifestSha256 };
          const record = { ...unsigned, hash: sha256(Buffer.from(canonicalJson(unsigned), "utf8")) };
          const handle = await open(path, sequence === 0 ? "wx" : "a", 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(record)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          records.push(record);
          previousHash = record.hash;
          sequence += 1;
          return record;
        };
        return await callback(Object.freeze({ records: Object.freeze([...records]), append }));
      } finally {
        await lock.close();
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    },
  });
}

async function loadJournal(path, manifestSha256) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) throw new Error("Migration journal is truncated or lacks its final LF");
  const records = bytes.toString("utf8").slice(0, -1).split("\n").map((line) => JSON.parse(line));
  let previousHash = "0".repeat(64);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertPlainObject(record, `journal record ${index}`);
    const { hash, ...unsigned } = record;
    if (record.sequence !== index || record.previousHash !== previousHash || record.manifestSha256 !== manifestSha256) {
      throw new Error(`Migration journal chain mismatch at record ${index}`);
    }
    const expected = sha256(Buffer.from(canonicalJson(unsigned), "utf8"));
    if (hash !== expected) throw new Error(`Migration journal hash mismatch at record ${index}`);
    previousHash = hash;
  }
  return records;
}

function parseStaleLock(bytes, manifestSha256, now) {
  let owner;
  try { owner = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`Stale migration lock is invalid JSON: ${message(error)}`); }
  assertPlainObject(owner, "stale migration lock");
  if (Object.keys(owner).sort().join("\0") !== ["host", "manifestSha256", "openedAt", "pid"].sort().join("\0")) throw new Error("Stale migration lock has unexpected fields");
  assertPositiveInteger(owner.pid, "stale migration lock PID");
  if (owner.host !== hostname()) throw new Error("Stale migration lock belongs to a different host");
  if (owner.manifestSha256 !== manifestSha256) throw new Error("Stale migration lock belongs to a different manifest");
  const openedAt = Date.parse(owner.openedAt);
  const observedAt = Date.parse(now);
  if (typeof owner.openedAt !== "string" || !Number.isFinite(openedAt) || !Number.isFinite(observedAt)) throw new Error("Stale migration lock timestamp is invalid");
  const age = observedAt - openedAt;
  if (age < 30_000 || age > 31 * 24 * 60 * 60 * 1000) throw new Error("Stale migration lock age is outside the audited recovery window");
  return owner;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function createCommandAdapter() {
  let githubToken;
  return Object.freeze({
    async run(spec) {
      const inheritedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
      const gitAuthentication = spec.capability?.startsWith("git.push-")
        ? githubToken
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`, "utf8").toString("base64")}`,
            }
          : fail("GitHub authentication must be acquired before an approved push")
        : {};
      const result = await execFileAsync(spec.executable, spec.args, {
        cwd: spec.cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...inheritedEnvironment,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...gitAuthentication,
        },
      });
      const output = { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: 0 };
      if (spec.capability === "github.auth-token") githubToken = output.stdout.trim();
      return output;
    },
  });
}

export function createFetchAdapter(command) {
  let token;
  return Object.freeze({
    async request(spec) {
      assertFetchShape(spec);
      const url = new URL(spec.url);
      const headers = new Headers(spec.headers ?? {});
      if (url.hostname === "api.github.com") {
        if (!headers.has("authorization") && !token) {
          const result = await runAllowedCommand(command, {
            capability: "github.auth-token",
            executable: "gh",
            args: ["auth", "token"],
            cwd: process.cwd(),
          }, {});
          token = result.stdout.trim();
          if (!token || /[\r\n]/u.test(token)) throw new Error("gh auth token returned an invalid token");
        }
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        headers.set("accept", headers.get("accept") ?? "application/vnd.github+json");
        headers.set("x-github-api-version", "2022-11-28");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), spec.timeoutMs ?? 20_000);
      try {
        return await globalThis.fetch(spec.url, {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          redirect: spec.redirect ?? "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

async function defaultVerifyLocalEvidence({ manifest, workspaceRoot, command }) {
  const checkedPaths = new Set();
  const hashEntry = async (entry, label) => {
    assertRelativePath(entry.path, `${label} path`);
    const path = resolve(workspaceRoot, entry.path);
    assertWithin(workspaceRoot, path, `${label} path`);
    const info = await stat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    if (entry.bytes !== undefined && info.size !== entry.bytes) throw new Error(`${label} byte count mismatch`);
    if (sha256(await readFile(path)) !== entry.sha256) throw new Error(`${label} SHA-256 mismatch`);
    checkedPaths.add(path);
  };
  for (const [name, entry] of Object.entries(manifest.localEvidence)) {
    if (name === "repositories") continue;
    await hashEntry(entry, `local evidence ${name}`);
  }
  for (const [index, entry] of manifest.privateBackups.entries()) await hashEntry(entry, `private backup ${index}`);
  for (const [name, repository] of Object.entries(manifest.localEvidence.repositories)) {
    const path = isolatedRepositoryPath(workspaceRoot, repository.path);
    const gitDirectory = join(path, ".git");
    const gitDirectoryInfo = await lstat(gitDirectory);
    if (!gitDirectoryInfo.isDirectory() || gitDirectoryInfo.isSymbolicLink()) throw new Error(`${name} must own a real .git directory`);
    const top = (await runAllowedCommand(command, localGitSpec(path, ["rev-parse", "--show-toplevel"]), { workspaceRoot })).stdout.trim();
    if (resolve(top) !== path) throw new Error(`${name} is not an isolated repository root`);
    const absoluteGitDirectory = (await runAllowedCommand(command, localGitSpec(path, ["rev-parse", "--absolute-git-dir"]), { workspaceRoot })).stdout.trim();
    if (resolve(absoluteGitDirectory) !== resolve(gitDirectory)) throw new Error(`${name} does not own its Git object database`);
    const configNames = (await runAllowedCommand(command, localGitSpec(path, ["config", "--local", "--name-only", "--null", "--list"]), { workspaceRoot })).stdout
      .split("\0")
      .filter(Boolean);
    for (const configName of configNames) {
      if (!ALLOWED_LOCAL_CONFIG.has(configName.toLocaleLowerCase("en-US"))) throw new Error(`${name} has unapproved local Git configuration: ${configName}`);
    }
    const hooksDirectory = join(gitDirectory, "hooks");
    const hookEntries = await readdir(hooksDirectory, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    for (const hook of hookEntries) {
      if (!hook.isFile() || hook.isSymbolicLink() || !hook.name.endsWith(".sample")) throw new Error(`${name} has an unapproved Git hook: ${hook.name}`);
    }
    const branchRef = `refs/heads/${repository.branch}`;
    const commit = (await runAllowedCommand(command, localGitSpec(path, ["rev-parse", "--verify", branchRef]), { workspaceRoot })).stdout.trim();
    if (commit !== repository.commit) throw new Error(`${name} commit mismatch`);
    const tree = (await runAllowedCommand(command, localGitSpec(path, ["rev-parse", "--verify", `${repository.commit}^{tree}`]), { workspaceRoot })).stdout.trim();
    if (tree !== repository.tree) throw new Error(`${name} tree mismatch`);
    const parents = (await runAllowedCommand(command, localGitSpec(path, ["rev-list", "--parents", "-n", "1", repository.commit]), { workspaceRoot })).stdout.trim().split(/\s+/u).slice(1);
    if ((repository.parent === null && parents.length !== 0) || (repository.parent !== null && (parents.length !== 1 || parents[0] !== repository.parent))) {
      throw new Error(`${name} parent mismatch`);
    }
    if (repository.tag) {
      const tagObject = (await runAllowedCommand(command, localGitSpec(path, ["rev-parse", "--verify", `refs/tags/${repository.tag}`]), { workspaceRoot })).stdout.trim();
      if (tagObject !== repository.tagObject) throw new Error(`${name} tag object mismatch`);
    }
    await runAllowedCommand(command, localGitSpec(path, ["fsck", "--full", "--strict"]), { workspaceRoot });
    const remotes = (await runAllowedCommand(command, localGitSpec(path, ["remote"]), { workspaceRoot })).stdout.trim();
    if (remotes) throw new Error(`${name} must have no configured remotes`);
  }
  return { checkedFiles: checkedPaths.size, checkedRepositories: Object.keys(manifest.localEvidence.repositories).length };
}

function localGitSpec(repository, subcommand) {
  return {
    capability: "git.local-verify",
    executable: "git",
    args: ["-c", `safe.directory=${repository}`, ...subcommand],
    cwd: repository,
  };
}

async function runAllowedCommand(command, spec, context) {
  assertCommandAllowed(spec, context);
  const result = await command.run(Object.freeze({ ...spec, args: Object.freeze([...spec.args]) }));
  if (!result || typeof result.stdout !== "string" || typeof result.stderr !== "string" || !Number.isInteger(result.exitCode ?? 0)) {
    throw new Error(`Command adapter returned an invalid result for ${spec.capability}`);
  }
  if ((result.exitCode ?? 0) !== 0) throw new Error(`${spec.capability} failed with exit code ${result.exitCode}`);
  return result;
}

async function runAllowedFetch(fetchAdapter, spec, context) {
  assertFetchAllowed(spec, context);
  return fetchAdapter.request(Object.freeze({
    ...spec,
    headers: Object.freeze({ ...(spec.headers ?? {}) }),
    body: spec.body === undefined ? undefined : Object.freeze(structuredClone(spec.body)),
  }));
}

export function assertFetchAllowed(spec, context) {
  assertFetchShape(spec);
  const manifest = context?.manifest;
  if (!manifest) throw new Error("Fetch authorization requires the pinned migration manifest");
  const url = new URL(spec.url);
  if (spec.capability === "pages.read-bytes") {
    if (spec.method !== "GET" || spec.body !== undefined) throw new Error("Pages verification is read-only");
    assertPagesUrl(url, manifest, url.hostname);
    return spec;
  }
  if (url.hostname !== "api.github.com") throw new Error("GitHub API capability escaped api.github.com");
  if (spec.capability === "github.read-app-installations") {
    const page = Number(url.searchParams.get("page"));
    const boundedPage = Number.isInteger(page) && page >= 1 && page <= 20 && url.searchParams.get("per_page") === "100" && url.searchParams.size === 2;
    if (spec.method !== "GET" || spec.body !== undefined || url.pathname !== "/app/installations" || !boundedPage || url.username || url.password || url.hash) {
      throw new Error("GitHub App installation read is outside the pinned allowlist");
    }
    assertAuthorizationHeader(spec, true);
    return spec;
  }
  if (spec.capability === "github.create-installation-token") {
    if (spec.method !== "POST" || !/^\/app\/installations\/[1-9]\d*\/access_tokens$/u.test(url.pathname) || url.search || canonicalJson(spec.body) !== canonicalJson({})) {
      throw new Error("GitHub installation-token creation is outside the pinned allowlist");
    }
    assertAuthorizationHeader(spec, true);
    return spec;
  }
  if (spec.capability === "github.read-installation-repositories") {
    const page = Number(url.searchParams.get("page"));
    const boundedPage = Number.isInteger(page) && page >= 1 && page <= 20 && url.searchParams.get("per_page") === "100" && url.searchParams.size === 2;
    if (spec.method !== "GET" || spec.body !== undefined || url.pathname !== "/installation/repositories" || !boundedPage) {
      throw new Error("GitHub installation repository read is outside the pinned allowlist");
    }
    assertAuthorizationHeader(spec, false);
    return spec;
  }
  const sourceOld = manifest.sourceRepository.currentName;
  const sourceNew = manifest.sourceRepository.approvedName;
  const userSite = manifest.userSiteRepository.name;
  const encodedPath = decodeURIComponent(url.pathname);
  const repositoryPrefix = [sourceOld, sourceNew, userSite]
    .map((name) => `/repos/${name}`)
    .find((prefix) => encodedPath === prefix || encodedPath.startsWith(`${prefix}/`));
  if (!repositoryPrefix || url.username || url.password || url.hash) throw new Error("GitHub API repository is outside the pinned allowlist");
  const suffix = encodedPath.slice(repositoryPrefix.length);
  const repository = repositoryPrefix.slice("/repos/".length);
  if (spec.capability === "github.read") {
    const staticSuffixes = new Set(["", "/environments", "/actions/variables", "/pages"]);
    const scalar = /^\/(?:git\/ref\/(?:heads|tags)\/.+|pulls\/\d+|releases\/\d+|environments\/(?:release-signing|legacy-update-feed)\/secrets)$/u.test(suffix) && !url.search;
    const page = Number(url.searchParams.get("page"));
    const boundedPage = Number.isInteger(page) && page >= 1 && page <= 20 && url.searchParams.get("per_page") === "100";
    const refInventory = ["/git/matching-refs/heads/", "/git/matching-refs/tags/"].includes(suffix) && boundedPage && url.searchParams.size === 2;
    const pullInventory = suffix === "/pulls" && boundedPage && url.searchParams.get("state") === "open" && url.searchParams.size === 3;
    const workflowInventory = suffix === "/actions/runs" && boundedPage && ACTIVE_WORKFLOW_STATUSES.includes(url.searchParams.get("status")) && url.searchParams.size === 3;
    const staticRead = staticSuffixes.has(suffix) && !url.search;
    if (spec.method !== "GET" || spec.body !== undefined || (!staticRead && !scalar && !refInventory && !pullInventory && !workflowInventory)) {
      throw new Error(`GitHub read endpoint is not allowlisted: ${suffix}${url.search}`);
    }
    return spec;
  }
  if (url.search) throw new Error("GitHub mutation may not contain a query string");
  const desired = manifest.sourceRepository.desiredMetadata;
  if (spec.capability === "github.rename-repository") {
    assertExactMutation(spec, "PATCH", sourceOld, "", { name: sourceNew.split("/")[1] });
  } else if (spec.capability === "github.close-pull-request") {
    const match = /^\/pulls\/(\d+)$/u.exec(suffix);
    const number = Number(match?.[1]);
    if (repository !== sourceNew || spec.method !== "PATCH" || !manifest.sourceRepository.pullRequestsToClose.some((pull) => pull.number === number) || canonicalJson(spec.body) !== canonicalJson({ state: "closed" })) {
      throw new Error("Pull request mutation is not an exact pinned closure");
    }
  } else if (spec.capability === "github.configure-repository") {
    assertExactMutation(spec, "PATCH", sourceNew, "", { description: desired.description, homepage: desired.homepage });
  } else if (spec.capability === "github.configure-topics") {
    assertExactMutation(spec, "PUT", sourceNew, "/topics", { names: desired.topics });
  } else if (spec.capability === "github.configure-pages") {
    const expected = repository === sourceNew
      ? { build_type: "workflow", cname: null, https_enforced: true }
      : repository === userSite
        ? { build_type: "legacy", source: manifest.userSiteRepository.desiredPages.source, cname: null, https_enforced: true }
        : null;
    if (!expected || spec.method !== "PUT" || suffix !== "/pages" || canonicalJson(spec.body) !== canonicalJson(expected)) {
      throw new Error("Pages mutation is not the exact approved configuration");
    }
  } else {
    throw new Error(`Mutation capability is not allowlisted: ${spec.capability}`);
  }
  return spec;

  function assertExactMutation(value, method, expectedRepository, expectedSuffix, expectedBody) {
    if (value.method !== method || repository !== expectedRepository || suffix !== expectedSuffix || canonicalJson(value.body) !== canonicalJson(expectedBody)) {
      throw new Error(`${value.capability} is not the exact approved mutation`);
    }
  }
}

export function assertCommandAllowed(spec, context = {}) {
  assertPlainObject(spec, "command specification");
  if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string" || /[\u0000\r\n]/u.test(arg))) {
    throw new Error("Commands must use a structured argument array without control characters");
  }
  if (spec.executable === "gh" && spec.capability === "github.auth-token" && canonicalJson(spec.args) === canonicalJson(["auth", "token"])) return spec;
  if (spec.executable !== "git") throw new Error(`Executable is not allowlisted for ${String(spec.capability)}`);
  switch (spec.capability) {
    case "git.local-verify": {
      if (spec.args[0] !== "-c" || spec.args[1] !== `safe.directory=${resolve(spec.cwd)}` || !ALLOWED_LOCAL_GIT.has(spec.args[2])) {
        throw new Error("Local Git verification command is outside the allowlist");
      }
      return spec;
    }
    case "git.execution-init": {
      if (canonicalJson(spec.args) !== canonicalJson(["init", "--bare", "--quiet", spec.args[3]]) || !context.temporary || !resolve(spec.args[3]).startsWith(`${resolve(context.temporary)}${sep}`)) {
        throw new Error("Execution repository initialization is outside the owned temporary directory");
      }
      return spec;
    }
    case "git.execution-import": {
      if (spec.args.length !== 9 || canonicalJson(spec.args.slice(0, 7)) !== canonicalJson(["-c", "protocol.version=2", "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head"])) {
        throw new Error("Execution object import is outside the allowlist");
      }
      const source = resolve(spec.args[7]);
      assertWithin(context.workspaceRoot, source, "execution import source");
      if (!context.temporary || !resolve(spec.cwd).startsWith(`${resolve(context.temporary)}${sep}`)) {
        throw new Error("Execution import target is outside the owned temporary directory");
      }
      if (!spec.args[8].startsWith("refs/") || !spec.args[8].includes(":refs/migration/")) throw new Error("Execution import refspec is unsafe");
      assertObjectId(spec.expectedObject, "imported expected object");
      return spec;
    }
    case "git.push-user-site-cas":
    case "git.push-source-atomic": {
      if (spec.cwd === context.workspaceRoot || !spec.cwd) throw new Error("Remote mutation may not operate from the development checkout");
      const expected = pushCommand(spec.capability === "git.push-source-atomic" ? buildSourcePush(context.manifest) : buildUserSitePush(context.manifest), context.manifest);
      if (canonicalJson(spec.args) !== canonicalJson(expected.args)) throw new Error("Git push command differs from the exact approved operation");
      return spec;
    }
    default:
      throw new Error(`Command capability is not allowlisted: ${String(spec.capability)}`);
  }
}

async function inspectGitHubRemote(context, fetchAdapter) {
  const { manifest } = context;
  const sourceName = await resolveSourceName(manifest, fetchAdapter, context);
  const sourceRepo = await apiGet(fetchAdapter, context, sourceName, "");
  const userRepo = await apiGet(fetchAdapter, context, manifest.userSiteRepository.name, "");
  const [ordinaryHeadRecords, ordinaryTagRecords, openPullRecords] = await Promise.all([
    apiListPaginated(fetchAdapter, context, sourceName, "/git/matching-refs/heads/", null),
    apiListPaginated(fetchAdapter, context, sourceName, "/git/matching-refs/tags/", null),
    apiListPaginated(fetchAdapter, context, sourceName, "/pulls?state=open", null),
  ]);
  const ordinaryHeads = ordinaryHeadRecords.map(normalizeOrdinaryRef);
  const ordinaryTags = ordinaryTagRecords.map(normalizeOrdinaryRef);
  const refs = Object.fromEntries([...ordinaryHeads, ...ordinaryTags].map((entry) => [entry.ref, entry.object]));
  const userMain = await readRef(fetchAdapter, context, manifest.userSiteRepository.name, SOURCE_REFS.main);
  const pulls = [];
  for (const expected of manifest.sourceRepository.pullRequestsToClose) {
    const pull = await apiGet(fetchAdapter, context, sourceName, `/pulls/${expected.number}`);
    pulls.push(normalizePull(pull));
  }
  const release = await apiGet(fetchAdapter, context, sourceName, `/releases/${manifest.release.id}`);
  const sourcePages = await apiGetOptional(fetchAdapter, context, sourceName, "/pages");
  const userPages = await apiGetOptional(fetchAdapter, context, manifest.userSiteRepository.name, "/pages");
  const prerequisites = await inspectPrerequisites(fetchAdapter, context, sourceName);
  let oldSlugRepositoryId = null;
  if (sourceName === manifest.sourceRepository.approvedName) {
    const old = await apiGetFollowingRedirects(fetchAdapter, context, manifest.sourceRepository.currentName, "", 3);
    oldSlugRepositoryId = old?.id ?? null;
  }
  return {
    sourceRepository: {
      repositoryId: sourceRepo.id,
      nodeId: sourceRepo.node_id,
      name: sourceRepo.full_name,
      refs,
      ordinaryHeads,
      ordinaryTags,
      pullRequests: pulls,
      openPullRequests: openPullRecords.map(normalizePull),
      release: normalizeRelease(release),
      metadata: { description: sourceRepo.description, homepage: sourceRepo.homepage, topics: sourceRepo.topics ?? [] },
      pages: normalizePages(sourcePages),
    },
    userSiteRepository: {
      repositoryId: userRepo.id,
      nodeId: userRepo.node_id,
      name: userRepo.full_name,
      refs: { [SOURCE_REFS.main]: userMain },
      pages: normalizePages(userPages),
    },
    oldSlugRepositoryId,
    prerequisites,
    pages: null,
  };
}

async function inspectPrerequisites(fetchAdapter, context, sourceName) {
  const manifest = context.manifest;
  const [environments, variables, releaseSecrets, legacySecrets, workflowGroups] = await Promise.all([
    apiGet(fetchAdapter, context, sourceName, "/environments"),
    apiGet(fetchAdapter, context, sourceName, "/actions/variables"),
    apiGetOptional(fetchAdapter, context, sourceName, "/environments/release-signing/secrets"),
    apiGetOptional(fetchAdapter, context, sourceName, "/environments/legacy-update-feed/secrets"),
    Promise.all(ACTIVE_WORKFLOW_STATUSES.map(async (status) => ({
      status,
      runs: await apiListPaginated(fetchAdapter, context, sourceName, `/actions/runs?status=${status}`, "workflow_runs"),
    }))),
  ]);
  const environmentNames = new Set((environments.environments ?? []).map((entry) => entry.name));
  const variableMap = new Map((variables.variables ?? []).map((entry) => [entry.name, entry.value]));
  const releaseSecretNames = new Set((releaseSecrets?.secrets ?? []).map((entry) => entry.name));
  const legacySecretNames = new Set((legacySecrets?.secrets ?? []).map((entry) => entry.name));
  const required = manifest.prerequisites;
  const environmentsReady = required.requiredEnvironments.every((name) => environmentNames.has(name));
  const variablesReady = Object.entries(required.requiredVariables).every(([name, value]) => value.startsWith("<") || variableMap.get(name) === value)
    && Number.isInteger(Number(variableMap.get("LEGACY_FEED_APP_ID")));
  const secretsReady = required.requiredEnvironmentSecrets["release-signing"].every((name) => releaseSecretNames.has(name))
    && required.requiredEnvironmentSecrets["legacy-update-feed"].every((name) => legacySecretNames.has(name));
  const requiredAppId = Number(variableMap.get("LEGACY_FEED_APP_ID"));
  const appInspection = Number.isSafeInteger(requiredAppId) && requiredAppId > 0
    ? await inspectLegacyFeedApp(fetchAdapter, context, requiredAppId)
    : { ready: false, installationId: null, repositories: [] };
  const appReady = appInspection.ready;
  const activeWorkflowRuns = workflowGroups.flatMap((group) => group.runs.map((run) => ({
    id: run.id,
    status: group.status,
    observedStatus: run.status,
    conclusion: run.conclusion ?? null,
  })));
  const workflowIds = new Set();
  for (const run of activeWorkflowRuns) {
    assertPositiveInteger(run.id, "active workflow run ID");
    if (!ACTIVE_WORKFLOW_STATUSES.includes(run.status) || workflowIds.has(run.id)) throw new Error("Active workflow inventory is invalid or duplicated");
    workflowIds.add(run.id);
  }
  const freezeReady = activeWorkflowRuns.length === 0;
  return {
    ready: environmentsReady && variablesReady && secretsReady && appReady && freezeReady,
    environmentsReady,
    variablesReady,
    secretsReady,
    appReady,
    appInstallationId: appInspection.installationId,
    freezeReady,
    activeWorkflowRuns,
  };
}

export async function inspectLegacyFeedApp(fetchAdapter, context, requiredAppId) {
  assertPositiveInteger(requiredAppId, "required legacy-feed App ID");
  if (context.appAuthentication?.appId !== requiredAppId || typeof context.appAuthentication?.createJwt !== "function") {
    throw new Error("Pinned legacy-feed App authentication is unavailable");
  }
  const appJwt = context.appAuthentication.createJwt();
  assertOpaqueBearer(appJwt, "legacy-feed App JWT", true);
  const installations = await apiListAppInstallations(fetchAdapter, context, appJwt);
  if (installations.length !== 1) return { ready: false, installationId: null, repositories: [] };
  const installation = installations[0];
  assertPositiveInteger(installation.id, "GitHub App installation ID");
  if (Number(installation.app_id) !== requiredAppId) return { ready: false, installationId: installation.id, repositories: [] };
  const expectedPermissions = context.manifest.prerequisites.requiredLegacyFeedApp.permissions;
  if (installation.repository_selection !== "selected" || canonicalJson(installation.permissions ?? {}) !== canonicalJson(expectedPermissions)) {
    return { ready: false, installationId: installation.id, repositories: [] };
  }
  const tokenResponse = await runAllowedFetch(fetchAdapter, {
    capability: "github.create-installation-token",
    method: "POST",
    url: `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    body: {},
    redirect: "manual",
    timeoutMs: 20_000,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt}`, "content-type": "application/json" },
  }, context);
  if (responseStatus(tokenResponse) !== 201) throw new Error(`GitHub installation-token creation returned HTTP ${responseStatus(tokenResponse)}`);
  const tokenPayload = await responseJson(tokenResponse);
  assertOpaqueBearer(tokenPayload?.token, "legacy-feed installation token", false);
  const now = Date.parse(context.clock());
  const expiresAt = Date.parse(tokenPayload?.expires_at);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + (65 * 60 * 1000)) {
    throw new Error("Legacy-feed installation token lifetime is invalid or not short-lived");
  }
  if (tokenPayload.repository_selection !== "selected" || canonicalJson(tokenPayload.permissions ?? {}) !== canonicalJson(expectedPermissions)) {
    throw new Error("Legacy-feed installation token permissions or selection differ from the approved App contract");
  }
  const repositories = await apiListInstallationRepositories(fetchAdapter, context, tokenPayload.token);
  const repositoryIds = repositories.map((repository) => repository.id);
  if (repositoryIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(repositoryIds).size !== repositoryIds.length) {
    throw new Error("GitHub App installation repository inventory is invalid or duplicated");
  }
  const ready = repositoryIds.length === 1
    && repositoryIds[0] === context.manifest.userSiteRepository.repositoryId
    && !repositoryIds.includes(context.manifest.sourceRepository.repositoryId);
  return { ready, installationId: installation.id, repositories: repositoryIds };
}

async function apiListAppInstallations(fetchAdapter, context, appJwt, maximumPages = 20) {
  const collected = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await runAllowedFetch(fetchAdapter, {
      capability: "github.read-app-installations",
      method: "GET",
      url: `https://api.github.com/app/installations?per_page=100&page=${page}`,
      redirect: "manual",
      timeoutMs: 20_000,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt}` },
    }, context);
    if (responseStatus(response) !== 200) throw new Error(`GitHub App installation read returned HTTP ${responseStatus(response)}`);
    const items = await responseJson(response);
    if (!Array.isArray(items) || items.length > 100) throw new Error("GitHub App installation pagination returned an invalid page");
    collected.push(...items);
    if (items.length < 100) return collected;
  }
  throw new Error("GitHub App installation pagination exceeded the fail-closed 20-page bound");
}

async function apiListInstallationRepositories(fetchAdapter, context, installationToken, maximumPages = 20) {
  const collected = [];
  let declaredTotal = null;
  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await runAllowedFetch(fetchAdapter, {
      capability: "github.read-installation-repositories",
      method: "GET",
      url: `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      redirect: "manual",
      timeoutMs: 20_000,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${installationToken}` },
    }, context);
    if (responseStatus(response) !== 200) throw new Error(`GitHub installation repository read returned HTTP ${responseStatus(response)}`);
    const payload = await responseJson(response);
    const items = payload?.repositories;
    if (!Number.isSafeInteger(payload?.total_count) || payload.total_count < 0 || !Array.isArray(items) || items.length > 100) {
      throw new Error("GitHub installation repository pagination returned an invalid page");
    }
    if (declaredTotal === null) declaredTotal = payload.total_count;
    if (payload.total_count !== declaredTotal) throw new Error("GitHub installation repository total changed during pagination");
    collected.push(...items);
    if (items.length < 100) {
      if (collected.length !== declaredTotal) throw new Error("GitHub installation repository inventory was truncated");
      return collected;
    }
  }
  throw new Error("GitHub installation repository pagination exceeded the fail-closed 20-page bound");
}

async function verifyPages(context, fetchAdapter, sleep) {
  const { manifest, manifestSha256 } = context;
  const endpoints = {
    canonical: manifest.postconditions.canonicalEndpoint,
    legacy: manifest.postconditions.legacyEndpoint,
  };
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const result = {};
      for (const [endpointName, base] of Object.entries(endpoints)) {
        const files = {};
        for (const expected of manifest.postconditions.feedFiles) {
          const url = new URL(encodeURIComponent(expected.name), ensureTrailingSlash(base));
          url.searchParams.set("migration", manifestSha256);
          const bytes = await fetchWithManualRedirects(fetchAdapter, context, url, 5);
          const actual = { bytes: bytes.length, sha256: sha256(bytes) };
          if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
            throw new Error(`${endpointName} Pages bytes differ for ${expected.name}`);
          }
          files[expected.name] = actual;
        }
        result[endpointName] = { files };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 6) break;
      await sleep(Math.min(1000 * (2 ** (attempt - 1)), 10_000));
    }
  }
  throw new Error(`Pages verification timed out after six bounded attempts: ${message(lastError)}`);
}

async function fetchWithManualRedirects(fetchAdapter, context, initialUrl, maximumRedirects) {
  let url = new URL(initialUrl);
  const allowedHost = url.hostname;
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    assertPagesUrl(url, context.manifest, allowedHost);
    const response = await runAllowedFetch(fetchAdapter, {
      capability: "pages.read-bytes",
      method: "GET",
      url: url.href,
      redirect: "manual",
      timeoutMs: 20_000,
      headers: { accept: "application/octet-stream", "cache-control": "no-cache" },
    }, context);
    const status = responseStatus(response);
    if (status === 200) return responseBytes(response);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = responseHeader(response, "location");
      if (!location || redirect === maximumRedirects) throw new Error("Pages redirect limit exceeded");
      url = new URL(location, url);
      continue;
    }
    throw new Error(`Pages returned HTTP ${status}`);
  }
  throw new Error("Pages redirect limit exceeded");
}

async function apiMutation(fetchAdapter, context, capability, repository, method, suffix, body) {
  const response = await runAllowedFetch(fetchAdapter, {
    capability,
    method,
    url: `https://api.github.com/repos/${repository}${suffix}`,
    body,
    redirect: "manual",
    timeoutMs: 20_000,
    headers: { accept: "application/vnd.github+json", "content-type": "application/json" },
  }, context);
  const status = responseStatus(response);
  if (status < 200 || status >= 300) throw new Error(`${capability} returned HTTP ${status}`);
  if (status === 204 || status === 205) return null;
  return responseJson(response);
}

async function apiGet(fetchAdapter, context, repository, suffix) {
  const response = await runAllowedFetch(fetchAdapter, {
    capability: "github.read",
    method: "GET",
    url: `https://api.github.com/repos/${repository}${suffix}`,
    redirect: "manual",
    timeoutMs: 20_000,
    headers: { accept: "application/vnd.github+json" },
  }, context);
  if (responseStatus(response) !== 200) throw new Error(`GitHub read returned HTTP ${responseStatus(response)} for ${repository}${suffix}`);
  return responseJson(response);
}

export async function apiListPaginated(fetchAdapter, context, repository, suffix, arrayKey, maximumPages = 20) {
  const collected = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = suffix.includes("?") ? "&" : "?";
    const payload = await apiGet(fetchAdapter, context, repository, `${suffix}${separator}per_page=100&page=${page}`);
    const items = arrayKey === null ? payload : payload?.[arrayKey];
    if (!Array.isArray(items) || items.length > 100) throw new Error(`GitHub pagination returned an invalid ${arrayKey ?? "array"} page`);
    collected.push(...items);
    if (items.length < 100) return collected;
  }
  throw new Error(`GitHub pagination exceeded the fail-closed ${maximumPages}-page bound for ${suffix}`);
}

async function apiGetOptional(fetchAdapter, context, repository, suffix, options = {}) {
  const response = await runAllowedFetch(fetchAdapter, {
    capability: "github.read",
    method: "GET",
    url: `https://api.github.com/repos/${repository}${suffix}`,
    redirect: "manual",
    timeoutMs: 20_000,
    headers: { accept: "application/vnd.github+json" },
  }, context);
  if (responseStatus(response) === 404) return null;
  if (options.allowRedirect === true && [301, 302, 307, 308].includes(responseStatus(response))) return null;
  if (responseStatus(response) !== 200) throw new Error(`GitHub optional read returned HTTP ${responseStatus(response)}`);
  return responseJson(response);
}

async function apiGetFollowingRedirects(fetchAdapter, context, repository, suffix, maximumRedirects) {
  let url = new URL(`https://api.github.com/repos/${repository}${suffix}`);
  for (let count = 0; count <= maximumRedirects; count += 1) {
    const response = await runAllowedFetch(fetchAdapter, {
      capability: "github.read",
      method: "GET",
      url: url.href,
      redirect: "manual",
      timeoutMs: 20_000,
      headers: { accept: "application/vnd.github+json" },
    }, context);
    if (responseStatus(response) === 404) return null;
    if (responseStatus(response) === 200) return responseJson(response);
    if ([301, 302, 307, 308].includes(responseStatus(response))) {
      const location = responseHeader(response, "location");
      if (!location || count === maximumRedirects) throw new Error("GitHub repository redirect limit exceeded");
      url = new URL(location, url);
      if (url.protocol !== "https:" || url.hostname !== "api.github.com") throw new Error("GitHub repository redirect escaped api.github.com");
      continue;
    }
    throw new Error(`GitHub repository redirect verification returned HTTP ${responseStatus(response)}`);
  }
  throw new Error("GitHub repository redirect limit exceeded");
}

async function resolveSourceName(manifest, fetchAdapter, context) {
  const current = await apiGetOptional(fetchAdapter, context, manifest.sourceRepository.currentName, "", { allowRedirect: true });
  if (current?.id === manifest.sourceRepository.repositoryId) return manifest.sourceRepository.currentName;
  const approved = await apiGetOptional(fetchAdapter, context, manifest.sourceRepository.approvedName, "");
  if (approved?.id === manifest.sourceRepository.repositoryId) return manifest.sourceRepository.approvedName;
  throw new Error("Pinned source repository ID is not reachable at either approved slug");
}

async function readRef(fetchAdapter, context, repository, ref) {
  const suffix = `/git/ref/${ref.replace(/^refs\//u, "")}`;
  const data = await apiGetOptional(fetchAdapter, context, repository, suffix);
  if (!data) return null;
  return data.object?.sha ?? fail(`GitHub ref ${ref} lacks an object SHA`);
}

function normalizePull(pull) {
  return {
    number: pull.number,
    nodeId: pull.node_id,
    state: pull.state,
    baseRef: pull.base?.ref,
    baseSha: pull.base?.sha,
    headRef: pull.head?.ref,
    headSha: pull.head?.sha,
  };
}

function normalizeOrdinaryRef(entry) {
  return { ref: entry.ref, object: entry.object?.sha };
}

function normalizeRelease(release) {
  return {
    id: release.id,
    tag: release.tag_name,
    assets: (release.assets ?? []).map((asset) => ({
      id: asset.id,
      name: asset.name,
      bytes: asset.size,
      sha256: typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : null,
    })),
  };
}

export function normalizePages(pages) {
  if (!pages) return null;
  return {
    buildType: pages.build_type,
    source: pages.source ? { branch: pages.source.branch, path: pages.source.path } : undefined,
    cname: pages.cname ?? null,
    httpsEnforced: pages.https_enforced,
    url: pages.html_url,
  };
}

function assertRemotePrerequisites(manifest, snapshot, forApply) {
  if (!forApply) return;
  if (!Array.isArray(snapshot.prerequisites?.activeWorkflowRuns)) throw new Error("Complete active workflow-run inventory is required");
  for (const run of snapshot.prerequisites.activeWorkflowRuns) {
    if (!ACTIVE_WORKFLOW_STATUSES.includes(run.status)) throw new Error(`Unsupported workflow status in freeze inventory: ${String(run.status)}`);
  }
  if (snapshot.prerequisites.activeWorkflowRuns.length > 0) {
    throw new Error(`Release freeze is not active; workflow runs remain in ${[...new Set(snapshot.prerequisites.activeWorkflowRuns.map((run) => run.status))].join(", ")}`);
  }
  if (manifest.prerequisites.ready !== true || snapshot.prerequisites?.ready !== true) {
    throw new Error("Required environments, variables, secrets, App scope, or release freeze are not verified ready");
  }
}

function assertPinnedRepository(actual, expected, label) {
  assertPlainObject(actual, `${label} remote repository`);
  if (actual.repositoryId !== expected.repositoryId || actual.nodeId !== expected.nodeId) {
    throw new Error(`${label} repository identity differs from the pinned manifest`);
  }
  const allowedNames = label === "source" ? [expected.currentName, expected.approvedName] : [expected.name];
  if (!allowedNames.includes(actual.name)) throw new Error(`${label} repository name is not approved`);
}

function assertPinnedRelease(actual, expected) {
  assertPlainObject(actual, "remote Release");
  if (actual.id !== expected.id || actual.tag !== expected.tag) throw new Error("Remote Release identity differs from the pinned manifest");
  if (!Array.isArray(actual.assets) || actual.assets.length !== expected.assets.length) throw new Error("Remote Release asset count differs");
  const byId = new Map(actual.assets.map((asset) => [asset.id, asset]));
  for (const asset of expected.assets) {
    const observed = byId.get(asset.id);
    if (!observed || observed.name !== asset.name || observed.bytes !== asset.bytes || observed.sha256 !== asset.sha256) {
      throw new Error(`Remote Release asset differs: ${asset.name}`);
    }
  }
}

function assertPinnedPullRequests(actual, expected, approvedNewBaseSha) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error("Remote pull request set differs from the pinned manifest");
  const byNumber = new Map(actual.map((pull) => [pull.number, pull]));
  for (const pinned of expected) {
    const pull = byNumber.get(pinned.number);
    if (!pull || pull.nodeId !== pinned.nodeId || pull.baseRef !== pinned.baseRef || ![pinned.baseSha, approvedNewBaseSha].includes(pull.baseSha) || pull.headRef !== pinned.headRef || pull.headSha !== pinned.headSha) {
      throw new Error(`Pull request #${pinned.number} identity drifted`);
    }
  }
}

function assertOrdinaryRefInventory(actual, manifest, sourceState) {
  if (!Array.isArray(actual.ordinaryHeads) || !Array.isArray(actual.ordinaryTags)) throw new Error("Complete ordinary head and tag inventories are required");
  const expectedHeads = new Map([
    [SOURCE_REFS.main, sourceState === "old" ? manifest.sourceRepository.main.expectedOld : manifest.sourceRepository.main.approvedNew],
    [SOURCE_REFS.pages, sourceState === "old" ? manifest.sourceRepository.ghPages.expectedOld : manifest.sourceRepository.ghPages.approvedNew],
  ]);
  if (sourceState === "old") {
    for (const branch of manifest.sourceRepository.branches) expectedHeads.set(`refs/heads/${branch.name}`, branch.expectedOld);
  }
  const expectedTags = new Map([[SOURCE_REFS.tag, sourceState === "old"
    ? manifest.sourceRepository["v0.8.3"].expectedOldTagObject
    : manifest.sourceRepository["v0.8.3"].approvedNewTagObject]]);
  assertExactInventory(actual.ordinaryHeads, expectedHeads, "ordinary head");
  assertExactInventory(actual.ordinaryTags, expectedTags, "ordinary tag");
  const refMap = actual.refs ?? {};
  const expectedRefs = [...expectedHeads, ...expectedTags];
  if (Object.keys(refMap).length !== expectedRefs.length) throw new Error("Remote ref map contains an unapproved ordinary ref");
  for (const [ref, object] of expectedRefs) {
    if (refMap[ref] !== object) throw new Error(`Remote ref map disagrees with complete inventory for ${ref}`);
  }
}

function assertExactInventory(actual, expected, label) {
  const observed = new Map();
  for (const entry of actual) {
    assertPlainObject(entry, `${label} inventory entry`);
    assertFullRef(entry.ref);
    assertObjectId(entry.object, `${label} ${entry.ref} object`);
    if (observed.has(entry.ref)) throw new Error(`Duplicate ${label} ${entry.ref}`);
    observed.set(entry.ref, entry.object);
  }
  if (observed.size !== expected.size) throw new Error(`Unexpected ${label} inventory size`);
  for (const [ref, object] of expected) {
    if (observed.get(ref) !== object) throw new Error(`Unexpected or missing ${label} ${ref}`);
  }
}

function assertOpenPullRequestInventory(openInventory, pinnedPulls, manifestPulls) {
  if (!Array.isArray(openInventory)) throw new Error("Complete open pull-request inventory is required");
  const allowedNumbers = new Set(manifestPulls.map((pull) => pull.number));
  const expectedOpen = new Set(pinnedPulls.filter((pull) => pull.state === "open").map((pull) => pull.number));
  const observed = new Set();
  for (const pull of openInventory) {
    assertPlainObject(pull, "open pull-request inventory entry");
    if (!allowedNumbers.has(pull.number)) throw new Error(`Unexpected open pull request #${String(pull.number)}`);
    const pinned = pinnedPulls.find((entry) => entry.number === pull.number);
    if (!pinned || canonicalJson(pull) !== canonicalJson(pinned)) throw new Error(`Open pull request #${pull.number} differs from its pinned identity`);
    if (observed.has(pull.number)) throw new Error(`Duplicate open pull request #${pull.number}`);
    observed.add(pull.number);
  }
  if (canonicalJson([...observed].sort((a, b) => a - b)) !== canonicalJson([...expectedOpen].sort((a, b) => a - b))) {
    throw new Error("Complete open pull-request inventory disagrees with pinned pull states");
  }
}

function classifyMetadataComponents(manifest, snapshot) {
  const source = snapshot.sourceRepository;
  const desired = manifest.sourceRepository.desiredMetadata;
  const captured = manifest.capturedInitialState;
  return Object.freeze({
    repositoryMetadata: exactComponentPhase(
      metadataIdentity(source.metadata),
      metadataIdentity(captured.sourceRepository.metadata),
      metadataIdentity(desired),
      "source repository metadata",
    ),
    repositoryTopics: exactComponentPhase(
      normalizedTopics(source.metadata?.topics),
      normalizedTopics(captured.sourceRepository.metadata.topics),
      normalizedTopics(desired.topics),
      "source repository topics",
    ),
    sourcePages: exactPagesComponentPhase(source.pages, captured.sourceRepository.pages, manifest.sourceRepository.desiredPages, "source Pages configuration"),
    userSitePages: exactPagesComponentPhase(snapshot.userSiteRepository.pages, captured.userSiteRepository.pages, manifest.userSiteRepository.desiredPages, "user-site Pages configuration"),
  });
}

function pagesConfigMatches(actual, desired) {
  if (!actual) return false;
  if (actual.buildType !== desired.buildType || actual.cname !== desired.cname || actual.httpsEnforced !== desired.httpsEnforced
    || normalizedHttpsUrl(actual.url) !== normalizedHttpsUrl(desired.url)) return false;
  return desired.source === undefined || canonicalJson(actual.source) === canonicalJson(desired.source);
}

function exactPagesComponentPhase(actual, captured, desired, label) {
  const oldMatch = pagesConfigMatches(actual, captured);
  const newMatch = pagesConfigMatches(actual, desired);
  if (!oldMatch && !newMatch) throw new Error(`${label} differs from both captured-old and approved-new state`);
  return newMatch;
}

function exactComponentPhase(actual, captured, desired, label) {
  const oldMatch = canonicalJson(actual) === canonicalJson(captured);
  const newMatch = canonicalJson(actual) === canonicalJson(desired);
  if (!oldMatch && !newMatch) throw new Error(`${label} differs from both captured-old and approved-new state`);
  return newMatch;
}

function metadataIdentity(metadata) {
  return { description: metadata?.description ?? null, homepage: metadata?.homepage ?? null };
}

function normalizedTopics(topics) {
  return [...(topics ?? [])].sort();
}

function normalizedHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function pagesBytesMatch(manifest, pages) {
  if (!pages) return false;
  for (const endpoint of ["canonical", "legacy"]) {
    for (const expected of manifest.postconditions.feedFiles) {
      const actual = pages[endpoint]?.files?.[expected.name];
      if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) return false;
    }
  }
  return true;
}

function exactOldOrNew(actual, oldValue, newValue, label) {
  if (actual === oldValue) return "old";
  if (actual === newValue) return "new";
  throw new Error(`Unapproved remote value for ${label}: ${String(actual)}`);
}

function assertPagesContracts(manifest, source, userSite, postconditions, capturedInitialState) {
  assertExactObjectKeys(capturedInitialState, ["sourceRepository", "userSiteRepository"], "captured initial state");
  const owner = userSite.name.split("/")[0];
  const repository = userSite.name.split("/")[1];
  if (repository.toLowerCase() !== `${owner.toLowerCase()}.github.io`) {
    throw new Error("User-site repository name is not the owner's GitHub Pages root repository");
  }
  const rootUrl = `https://${owner.toLowerCase()}.github.io/`;
  const oldProject = source.currentName.split("/")[1];
  const newProject = source.approvedName.split("/")[1];
  const canonicalUrl = new URL(`${newProject}/`, rootUrl).href;
  const legacyUrl = new URL(`${oldProject}/`, rootUrl).href;
  const desiredMetadata = requiredObject(source, "desiredMetadata");
  assertExactObjectKeys(desiredMetadata, ["description", "homepage", "topics"], "source desired metadata");
  assertNonempty(desiredMetadata.description, "source desired description");
  assertHttpsReference(desiredMetadata.homepage, "source desired homepage");
  assertStringSet(desiredMetadata.topics, "source desired topics");

  const desiredSourcePages = requiredObject(source, "desiredPages");
  const desiredUserPages = requiredObject(userSite, "desiredPages");
  assertExactPagesConfig(desiredSourcePages, {
    buildType: "workflow", cname: null, httpsEnforced: true, url: canonicalUrl,
  }, "source desired Pages configuration");
  assertExactPagesConfig(desiredUserPages, {
    buildType: "legacy", source: { branch: "main", path: "/" }, cname: null, httpsEnforced: true, url: rootUrl,
  }, "user-site desired Pages configuration");
  if (postconditions.canonicalEndpoint !== canonicalUrl || postconditions.legacyEndpoint !== legacyUrl) {
    throw new Error("Pages feed endpoints do not match the canonical project path and legacy compatibility path");
  }

  const capturedSourceRepository = requiredObject(capturedInitialState, "sourceRepository");
  const capturedUserSiteRepository = requiredObject(capturedInitialState, "userSiteRepository");
  assertExactObjectKeys(capturedSourceRepository, ["metadata", "pages"], "captured source repository state");
  assertExactObjectKeys(capturedUserSiteRepository, ["pages"], "captured user-site repository state");
  const capturedSource = requiredObject(capturedSourceRepository, "pages");
  const capturedUser = requiredObject(capturedUserSiteRepository, "pages");
  const capturedMetadata = requiredObject(capturedSourceRepository, "metadata");
  assertExactObjectKeys(capturedMetadata, ["description", "homepage", "topics"], "captured source metadata");
  if (capturedMetadata.description !== null && typeof capturedMetadata.description !== "string") throw new Error("Captured source description must be a string or null");
  if (capturedMetadata.homepage !== null) assertHttpsReference(capturedMetadata.homepage, "captured source homepage");
  assertStringSet(capturedMetadata.topics, "captured source topics");
  assertExactPagesConfig(capturedSource, {
    buildType: "legacy", source: { branch: "gh-pages", path: "/" }, cname: null, httpsEnforced: true, url: legacyUrl,
  }, "captured source Pages configuration");
  assertExactPagesConfig(capturedUser, desiredUserPages, "captured user-site Pages configuration");
}

function assertPrerequisiteContract(manifest, prerequisites, options) {
  assertExactObjectKeys(prerequisites, [
    "ready", "releaseFreeze", "requiredEnvironments", "requiredVariables", "requiredEnvironmentSecrets", "requiredLegacyFeedApp", "missingAtCapture",
  ], "migration prerequisites");
  assertExactStringSet(prerequisites.requiredEnvironments, ["github-pages", "release-signing", "legacy-update-feed"], "required environments");
  const variables = requiredObject(prerequisites, "requiredVariables");
  assertExactObjectKeys(variables, ["UPDATER_FEED_MODE", "LEGACY_FEED_REPOSITORY", "LEGACY_FEED_APP_ID"], "required variables");
  if (variables.UPDATER_FEED_MODE !== "dual" || variables.LEGACY_FEED_REPOSITORY !== manifest.userSiteRepository.name) {
    throw new Error("Required updater variables are not the exact dual-feed contract");
  }
  const appIdIsNumeric = /^[1-9][0-9]*$/u.test(variables.LEGACY_FEED_APP_ID);
  const readyContract = prerequisites.ready === true || manifest.approvalEligible === true || options.forApply === true;
  if (!appIdIsNumeric && variables.LEGACY_FEED_APP_ID !== "<numeric-dedicated-app-id>") throw new Error("LEGACY_FEED_APP_ID is neither numeric nor the exact ineligible placeholder");
  if (readyContract && !appIdIsNumeric) throw new Error("Eligible/apply prerequisites require a numeric LEGACY_FEED_APP_ID");

  const secrets = requiredObject(prerequisites, "requiredEnvironmentSecrets");
  assertExactObjectKeys(secrets, ["release-signing", "legacy-update-feed"], "required environment secrets");
  assertExactStringSet(secrets["release-signing"], ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], "release-signing secrets");
  assertExactStringSet(secrets["legacy-update-feed"], ["LEGACY_FEED_APP_PRIVATE_KEY"], "legacy-update-feed secrets");
  const app = requiredObject(prerequisites, "requiredLegacyFeedApp");
  assertExactObjectKeys(app, ["installedOnlyOn", "permissions"], "required legacy-feed App");
  if (app.installedOnlyOn !== manifest.userSiteRepository.name
    || canonicalJson(app.permissions) !== canonicalJson({ metadata: "read", contents: "write" })) {
    throw new Error("Legacy-feed App must have exactly Metadata read and Contents write only on the user-site repository");
  }
  const releaseFreeze = requiredObject(prerequisites, "releaseFreeze");
  assertExactObjectKeys(releaseFreeze, ["required", "activeReleaseWorkflowRunsAtCapture"], "release freeze");
  if (releaseFreeze.required !== true || !Array.isArray(releaseFreeze.activeReleaseWorkflowRunsAtCapture)
    || releaseFreeze.activeReleaseWorkflowRunsAtCapture.length !== 0) {
    throw new Error("Release freeze prerequisite must require an empty captured active-run inventory");
  }
  if (!Array.isArray(prerequisites.missingAtCapture) || prerequisites.missingAtCapture.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("missingAtCapture must be an explicit string array");
  }
  if (readyContract && prerequisites.missingAtCapture.length !== 0) throw new Error("Eligible/apply prerequisites may not contain missing gaps");
}

function assertExactPagesConfig(actual, expected, label) {
  assertPlainObject(actual, label);
  assertExactObjectKeys(actual, Object.keys(expected), label);
  assertHttpsUrl(actual.url, `${label} URL`);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} is not exact`);
}

function assertHttpsReference(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${label} must be an HTTPS URL`);
}

function assertExactObjectKeys(value, keys, label) {
  assertPlainObject(value, label);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${label} has unexpected fields`);
}

function assertStringSet(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be a nonempty unique string array`);
  }
}

function assertExactStringSet(actual, expected, label) {
  if (!Array.isArray(actual) || canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())) throw new Error(`${label} are not exact`);
}

function assertLocalEvidence(local, manifest) {
  const repositories = requiredObject(local, "repositories");
  const requirements = {
    sourceRoot: [manifest.sourceRepository.main.approvedNew, manifest.sourceRepository.main.approvedTree, null],
    canonicalGhPages: [manifest.sourceRepository.ghPages.approvedNew, manifest.sourceRepository.ghPages.approvedTree, manifest.sourceRepository.ghPages.expectedOld],
    userSite: [manifest.userSiteRepository.main.approvedNew, manifest.userSiteRepository.main.approvedTree, null],
    "sanitizedV0.8.3": [manifest.sourceRepository["v0.8.3"].approvedNewCommit, manifest.sourceRepository["v0.8.3"].approvedNewTree, null],
  };
  for (const [name, [commit, tree, parent]] of Object.entries(requirements)) {
    const repository = requiredObject(repositories, name);
    assertRelativePath(repository.path, `${name} path`);
    if (repository.commit !== commit || repository.tree !== tree || repository.parent !== parent) throw new Error(`${name} local evidence differs from approved objects`);
    assertSafeBranch(repository.branch);
  }
  if (repositories.sourceRoot.branch !== "main" || repositories.canonicalGhPages.branch !== "gh-pages" || repositories.userSite.branch !== "main") {
    throw new Error("Local evidence repository branches differ from approved refs");
  }
  if (repositories["sanitizedV0.8.3"].tag !== "v0.8.3" || repositories["sanitizedV0.8.3"].tagObject !== manifest.sourceRepository["v0.8.3"].approvedNewTagObject) {
    throw new Error("Sanitized v0.8.3 local tag evidence differs");
  }
  for (const [name, entry] of Object.entries(local)) {
    if (name === "repositories") continue;
    assertPlainObject(entry, `local evidence ${name}`);
    assertRelativePath(entry.path, `${name} path`);
    assertSha256(entry.sha256, `${name} SHA-256`);
    if (entry.bytes !== undefined) assertPositiveInteger(entry.bytes, `${name} byte count`);
  }
}

function assertRefTransition(value, label, action) {
  assertPlainObject(value, label);
  assertObjectId(value.expectedOld, `${label} expected old object`);
  assertObjectId(value.approvedNew, `${label} approved new object`);
  assertObjectId(value.approvedTree, `${label} approved tree`);
  if (value.expectedOld === value.approvedNew || value.action !== action) throw new Error(`${label} transition is not exact`);
}

function assertCanonicalManifestBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes[0] === 0xef || bytes.at(-1) !== 0x0a) {
    throw new Error("Manifest must be nonempty UTF-8 without BOM and end in one LF");
  }
  const text = bytes.toString("utf8");
  if (text.endsWith("\n\n") || text.includes("\r")) throw new Error("Manifest must use canonical LF endings and exactly one final LF");
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`Manifest is invalid JSON: ${message(error)}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Manifest root must be a JSON object");
}

function assertNoBroadPushArguments(args) {
  for (const arg of args) {
    if (["origin", "HEAD", "--force", "-f", "--mirror", "--all", "--delete"].includes(arg) || arg.startsWith("+") || arg.includes("*:")) {
      throw new Error(`Forbidden broad Git push argument: ${arg}`);
    }
  }
}

function assertFetchShape(spec) {
  assertPlainObject(spec, "fetch specification");
  if (!new Set(["GET", "PATCH", "POST", "PUT"]).has(spec.method)) throw new Error("Fetch method is not allowlisted");
  const url = new URL(spec.url);
  if (url.protocol !== "https:" || !["api.github.com", "leonxlnx.github.io"].includes(url.hostname)) throw new Error("Fetch URL is not allowlisted");
  if (spec.redirect !== "manual") throw new Error("Every migration fetch must use manual redirect handling");
  if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 30_000) throw new Error("Fetch timeout is not bounded");
  const allowedCapabilities = new Set([
    "github.read", "github.rename-repository", "github.close-pull-request", "github.configure-repository",
    "github.configure-topics", "github.configure-pages", "github.read-app-installations", "github.create-installation-token",
    "github.read-installation-repositories", "pages.read-bytes",
  ]);
  if (!allowedCapabilities.has(spec.capability)) throw new Error("Fetch capability is not allowlisted");
}

function assertPagesUrl(url, manifest, allowedHost) {
  if (url.protocol !== "https:" || url.hostname !== allowedHost || url.hostname !== "leonxlnx.github.io") throw new Error("Pages redirect escaped the approved host");
  const bases = [manifest.postconditions.canonicalEndpoint, manifest.postconditions.legacyEndpoint].map((entry) => new URL(entry).pathname);
  if (!bases.some((base) => url.pathname.startsWith(base))) throw new Error("Pages URL escaped the approved endpoint prefix");
}

function assertWithin(root, target, label) {
  const fromRoot = relative(resolve(root), resolve(target));
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) throw new Error(`${label} must be a child of the workspace root`);
}

function isolatedRepositoryPath(workspaceRoot, path) {
  assertRelativePath(path, "isolated repository path");
  const repository = resolve(workspaceRoot, path);
  assertWithin(workspaceRoot, repository, "isolated repository path");
  if (repository === resolve(workspaceRoot)) throw new Error("Migration may never operate from the development checkout");
  return repository;
}

function assertRelativePath(path, label) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0")) throw new Error(`${label} must be a relative path`);
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} contains unsafe path segments`);
}

function assertSafeBranch(value) {
  assertNonempty(value, "branch name");
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..") || /[~^:?*[\\\s\u0000-\u001f\u007f]/u.test(value) || value.includes("@{")) {
    throw new Error(`Unsafe branch name ${value}`);
  }
}

function assertFullRef(ref) {
  if (typeof ref !== "string" || !/^refs\/(?:heads|tags)\//u.test(ref) || ref.includes("..") || /[~^:?*[\\\s]/u.test(ref)) throw new Error(`Unsafe full ref ${String(ref)}`);
}

function assertSafeFileName(name, label) {
  if (typeof name !== "string" || !name || basename(name) !== name || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error(`${label} is unsafe`);
}

function assertRepositoryName(value, label) {
  if (typeof value !== "string" || !REPOSITORY_NAME.test(value) || value.includes("..")) throw new Error(`${label} is invalid`);
}

function assertObjectId(value, label) {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw new Error(`${label} must be a lowercase 40-character object ID`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertNonempty(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/u.test(value)) throw new Error(`${label} must be a nonempty single-line string`);
}

function assertAuthorizationHeader(spec, jwt) {
  const header = spec.headers?.authorization ?? spec.headers?.Authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) throw new Error("GitHub App API request lacks explicit bearer authentication");
  assertOpaqueBearer(header.slice("Bearer ".length), jwt ? "legacy-feed App JWT" : "legacy-feed installation token", jwt);
}

function assertOpaqueBearer(value, label, jwt) {
  if (typeof value !== "string" || value.length < 10 || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (jwt && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`${label} is not a compact JWT`);
  if (!jwt && !/^[A-Za-z0-9_.-]+$/u.test(value)) throw new Error(`${label} is invalid`);
}

function assertHttpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must be a clean HTTPS URL`);
}

function requiredObject(parent, key) {
  const value = parent[key];
  assertPlainObject(value, key);
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function responseStatus(response) {
  return Number(response?.status);
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  return response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()] ?? null;
}

async function responseJson(response) {
  if (typeof response?.json === "function") return response.json();
  if (response?.body && !Buffer.isBuffer(response.body)) return response.body;
  return JSON.parse((await responseBytes(response)).toString("utf8"));
}

async function responseBytes(response) {
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (typeof response?.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer());
  if (typeof response?.text === "function") return Buffer.from(await response.text(), "utf8");
  throw new Error("Fetch adapter response has no readable body");
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(text) {
  throw new Error(text);
}

function parseCli(argv) {
  const args = [...argv];
  let mode = "verify";
  if (args[0] && !args[0].startsWith("--")) mode = args.shift();
  const output = { mode };
  const keys = new Map([
    ["--manifest", "manifestPath"],
    ["--expected-manifest-sha256", "expectedManifestSha256"],
    ["--approval-file", "approvalFile"],
    ["--legacy-feed-app-private-key", "legacyFeedAppPrivateKeyPath"],
    ["--recover-stale-lock-sha256", "recoverStaleLockSha256"],
    ["--workspace-root", "workspaceRoot"],
  ]);
  while (args.length) {
    const flag = args.shift();
    const key = keys.get(flag);
    if (!key || !args[0] || args[0].startsWith("--")) throw new Error(`Unknown or incomplete argument ${String(flag)}`);
    output[key] = args.shift();
  }
  return output;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await createMigrationExecutor().run(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  }
}
