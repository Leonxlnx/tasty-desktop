import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const APPROVAL_FORMAT = "APPROVE CLEAN-ROOT MIGRATION MANIFEST <sha256-of-this-file>";
const APPROVAL_PREFIX = "APPROVE CLEAN-ROOT MIGRATION MANIFEST";
const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^[0-9a-f]{40}$/u;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const REQUIRED_OPTIONS = [
  "manifest",
  "artifactRoot",
  "sourceRepo",
  "canonicalRepo",
  "userSiteRepo",
  "sanitizedV083Repo",
];
const ALLOWED_GIT_COMMANDS = new Set([
  "cat-file",
  "config",
  "for-each-ref",
  "fsck",
  "rev-parse",
  "status",
  "symbolic-ref",
]);

export async function checkMigrationApproval(input = {}) {
  const options = normalizeOptions(input);
  const artifactRoot = await requireDirectory(options.artifactRoot, "artifact root");
  const manifestFile = await readPinnedFile(options.manifest, { label: "approval manifest", maxBytes: MAX_MANIFEST_BYTES });
  const manifest = parseManifest(manifestFile.bytes);
  validateManifestShape(manifest);

  const localEvidence = requireRecord(manifest.localEvidence, "localEvidence");
  const repositories = requireRecord(localEvidence.repositories, "localEvidence.repositories");
  const repositoryOptions = [
    ["source root", options.sourceRepo, requireRecord(repositories.sourceRoot, "localEvidence.repositories.sourceRoot")],
    ["canonical gh-pages preseed", options.canonicalRepo, requireRecord(repositories.canonicalGhPages, "localEvidence.repositories.canonicalGhPages")],
    ["user-site preseed", options.userSiteRepo, requireRecord(repositories.userSite, "localEvidence.repositories.userSite")],
    ["sanitized v0.8.3 repository", options.sanitizedV083Repo, requireRecord(repositories["sanitizedV0.8.3"], "localEvidence.repositories.sanitizedV0.8.3")],
  ];

  const artifactRecords = collectArtifactRecords(manifest);
  const artifactResults = [];
  let remoteSnapshot;
  for (const record of artifactRecords) {
    const verified = await verifyArtifact(artifactRoot, record);
    artifactResults.push(verified.result);
    if (record.label === "localEvidence.remoteSnapshot") remoteSnapshot = parseJsonEvidence(verified.bytes, record.label);
  }
  if (!remoteSnapshot) throw new Error("localEvidence.remoteSnapshot was not verified");
  validateCapturedInitialState(manifest, remoteSnapshot);

  const repoPaths = {};
  for (const [label, explicitPath, evidence] of repositoryOptions) {
    const expectedPath = await resolveContainedPath(artifactRoot, requireString(evidence.path, `${label} evidence path`), label, true);
    const actualPath = await requireDirectory(explicitPath, label);
    if (actualPath !== expectedPath) {
      throw new Error(`${label} option does not resolve to the manifest-pinned path`);
    }
    repoPaths[label] = actualPath;
  }

  const source = requireRecord(manifest.sourceRepository, "sourceRepository");
  const sourceMain = requireRecord(source.main, "sourceRepository.main");
  const sourcePages = requireRecord(source.ghPages, "sourceRepository.ghPages");
  const releaseTag = requireRecord(source["v0.8.3"], "sourceRepository.v0.8.3");
  const userSite = requireRecord(manifest.userSiteRepository, "userSiteRepository");
  const userSiteMain = requireRecord(userSite.main, "userSiteRepository.main");

  const repositoryResults = {};
  repositoryResults.source = await verifyRepository({
    label: "source root",
    path: repoPaths["source root"],
    branch: "main",
    commit: sourceMain.approvedNew,
    tree: sourceMain.approvedTree,
    parent: null,
    expectedRefs: new Map([["refs/heads/main", { object: sourceMain.approvedNew, type: "commit" }]]),
  });
  repositoryResults.canonical = await verifyRepository({
    label: "canonical gh-pages preseed",
    path: repoPaths["canonical gh-pages preseed"],
    branch: "gh-pages",
    commit: sourcePages.approvedNew,
    tree: sourcePages.approvedTree,
    parent: sourcePages.expectedOld,
    expectedRefs: new Map([["refs/heads/gh-pages", { object: sourcePages.approvedNew, type: "commit" }]]),
  });
  repositoryResults.userSite = await verifyRepository({
    label: "user-site preseed",
    path: repoPaths["user-site preseed"],
    branch: "main",
    commit: userSiteMain.approvedNew,
    tree: userSiteMain.approvedTree,
    parent: null,
    expectedRefs: new Map([["refs/heads/main", { object: userSiteMain.approvedNew, type: "commit" }]]),
  });
  repositoryResults.sanitizedV083 = await verifyRepository({
    label: "sanitized v0.8.3 repository",
    path: repoPaths["sanitized v0.8.3 repository"],
    branch: "main",
    commit: releaseTag.approvedNewCommit,
    tree: releaseTag.approvedNewTree,
    parent: null,
    tag: { name: "v0.8.3", object: releaseTag.approvedNewTagObject, commit: releaseTag.approvedNewCommit },
    expectedRefs: new Map([
      ["refs/heads/main", { object: releaseTag.approvedNewCommit, type: "commit" }],
      ["refs/tags/v0.8.3", { object: releaseTag.approvedNewTagObject, type: "tag" }],
    ]),
  });

  assertRepositoryEvidence(repositories, {
    sourceRoot: repositoryResults.source,
    canonicalGhPages: repositoryResults.canonical,
    userSite: repositoryResults.userSite,
    "sanitizedV0.8.3": repositoryResults.sanitizedV083,
  });

  const manifestSha256 = sha256(manifestFile.bytes);
  const approvalPhrase = `${APPROVAL_PREFIX} ${manifestSha256}`;
  const missing = approvalMissingItems(manifest);
  const eligible = manifest.approvalEligible === true && manifest.prerequisites.ready === true && missing.length === 0;
  if (options.mode === "approve" && !eligible) {
    throw new Error(`Migration is not eligible for approval: ${missing.join("; ")}`);
  }

  return {
    mode: options.mode,
    eligible,
    missing,
    manifestSha256,
    approvalPhrase: options.mode === "approve" ? approvalPhrase : undefined,
    artifacts: artifactResults,
    repositories: repositoryResults,
  };
}

function normalizeOptions(input) {
  if (!isRecord(input)) throw new Error("Options must be an object");
  const allowed = new Set([...REQUIRED_OPTIONS, "mode"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
  }
  const normalized = {};
  for (const key of REQUIRED_OPTIONS) normalized[key] = requireString(input[key], `--${toKebabCase(key)}`);
  normalized.mode = input.mode ?? "inspect";
  if (!new Set(["inspect", "approve"]).has(normalized.mode)) throw new Error(`Unsupported mode: ${normalized.mode}`);
  for (const key of REQUIRED_OPTIONS) normalized[key] = resolve(normalized[key]);
  return normalized;
}

function parseManifest(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("Approval manifest must be UTF-8 without a BOM");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Approval manifest is not valid JSON: ${message(error)}`);
  }
  return requireRecord(manifest, "approval manifest");
}

function parseJsonEvidence(bytes, label) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${label} must be UTF-8 without a BOM`);
  try {
    return requireRecord(JSON.parse(bytes.toString("utf8")), `${label} JSON`);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${message(error)}`);
  }
}

function validateManifestShape(manifest) {
  if (manifest.schemaVersion !== 1) throw new Error("Approval manifest schemaVersion must be 1");
  if (manifest.approvalRequired !== true) throw new Error("Approval manifest approvalRequired must be true");
  if (typeof manifest.approvalEligible !== "boolean") throw new Error("Approval manifest approvalEligible must be a boolean");
  if (manifest.approvalFormat !== APPROVAL_FORMAT) throw new Error(`Approval manifest approvalFormat must be exactly: ${APPROVAL_FORMAT}`);
  validateHashFields(manifest, "manifest");
  validateGitObjectFields(manifest, "manifest");

  const source = requireRecord(manifest.sourceRepository, "sourceRepository");
  requirePositiveInteger(source.repositoryId, "sourceRepository.repositoryId");
  requireString(source.nodeId, "sourceRepository.nodeId");
  const main = requireGitUpdate(source.main, "sourceRepository.main");
  const pages = requireGitUpdate(source.ghPages, "sourceRepository.ghPages");
  if (main.action !== "replace-with-exact-force-with-lease" || pages.action !== "fast-forward-only") throw new Error("Source branch actions are not pinned to the approved safety modes");
  const releaseTag = requireRecord(source["v0.8.3"], "sourceRepository.v0.8.3");
  for (const key of ["expectedOldTagObject", "expectedOldCommit", "expectedOldTree", "approvedNewTagObject", "approvedNewCommit", "approvedNewTree"]) {
    requireObjectId(releaseTag[key], `sourceRepository.v0.8.3.${key}`);
  }
  if (releaseTag.action !== "retarget-with-exact-tag-lease-preserve-release") throw new Error("v0.8.3 action is not pinned to exact lease and Release preservation");
  const userSite = requireRecord(manifest.userSiteRepository, "userSiteRepository");
  requirePositiveInteger(userSite.repositoryId, "userSiteRepository.repositoryId");
  requireString(userSite.nodeId, "userSiteRepository.nodeId");
  if (source.repositoryId === userSite.repositoryId || source.nodeId === userSite.nodeId) throw new Error("Source and user-site repository identities must be distinct");
  const userMain = requireGitUpdate(userSite.main, "userSiteRepository.main");
  if (userMain.action !== "replace-with-exact-force-with-lease") throw new Error("User-site main action is not pinned to exact force-with-lease");
  const cname = requireRecord(userSite.cname, "userSiteRepository.cname");
  if (cname.decision !== "omit") throw new Error("User-site CNAME decision must be omit");
  const localEvidence = requireRecord(manifest.localEvidence, "localEvidence");
  validateRepositoryEvidenceShape(localEvidence.repositories);

  const branches = requireArray(source.branches, "sourceRepository.branches");
  const branchMap = new Map();
  for (const [index, rawBranch] of branches.entries()) {
    const branch = requireRecord(rawBranch, `sourceRepository.branches[${index}]`);
    const name = requireString(branch.name, `sourceRepository.branches[${index}].name`);
    const expectedOld = requireObjectId(branch.expectedOld, `sourceRepository.branches[${index}].expectedOld`);
    if (branch.action !== "lease-delete") throw new Error(`Pinned branch ${name} must use lease-delete`);
    if (branchMap.has(name)) throw new Error(`Duplicate pinned branch: ${name}`);
    branchMap.set(name, expectedOld);
  }
  validatePinnedPullRequests(source.pullRequestsToClose, branchMap, main.expectedOld);
  validatePages(source, userSite, manifest.postconditions);
  validatePrerequisites(manifest);
  validateDeferredGates(manifest.deferredGates, source);
  validateExecution(manifest.execution, {
    source,
    main,
    pages,
    releaseTag,
    userSite,
    userMain,
    branchCount: branches.length,
  });
  validateRequiredBeforeMutation(manifest.requiredBeforeMutation);
  validateForbidden(manifest.forbidden);
  validatePostconditions(manifest.postconditions, manifest.release);
}

function requireGitUpdate(value, label) {
  const update = requireRecord(value, label);
  return {
    ...update,
    expectedOld: requireObjectId(update.expectedOld, `${label}.expectedOld`),
    approvedNew: requireObjectId(update.approvedNew, `${label}.approvedNew`),
    approvedTree: requireObjectId(update.approvedTree, `${label}.approvedTree`),
  };
}

function validateRepositoryEvidenceShape(value) {
  const repositories = requireRecord(value, "localEvidence.repositories");
  const specifications = [
    ["sourceRoot", "main", false],
    ["canonicalGhPages", "gh-pages", true],
    ["userSite", "main", false],
    ["sanitizedV0.8.3", "main", false],
  ];
  for (const [key, branch, hasParent] of specifications) {
    const entry = requireRecord(repositories[key], `localEvidence.repositories.${key}`);
    requireString(entry.path, `localEvidence.repositories.${key}.path`);
    if (entry.branch !== branch) throw new Error(`localEvidence.repositories.${key}.branch must be ${branch}`);
    requireObjectId(entry.commit, `localEvidence.repositories.${key}.commit`);
    requireObjectId(entry.tree, `localEvidence.repositories.${key}.tree`);
    if (hasParent) requireObjectId(entry.parent, `localEvidence.repositories.${key}.parent`);
    else if (entry.parent !== null) throw new Error(`localEvidence.repositories.${key}.parent must be null`);
  }
  const tagged = repositories["sanitizedV0.8.3"];
  if (tagged.tag !== "v0.8.3") throw new Error("localEvidence.repositories.sanitizedV0.8.3.tag must be v0.8.3");
  requireObjectId(tagged.tagObject, "localEvidence.repositories.sanitizedV0.8.3.tagObject");
}

function validatePinnedPullRequests(value, branchMap, mainSha) {
  const pulls = requireArray(value, "sourceRepository.pullRequestsToClose");
  if (pulls.length !== branchMap.size || pulls.length === 0) throw new Error("Pinned pull request metadata must cover every branch deletion exactly once");
  const numbers = new Set();
  const heads = new Set();
  for (const [index, rawPull] of pulls.entries()) {
    const pull = requireRecord(rawPull, `sourceRepository.pullRequestsToClose[${index}]`);
    if (!Number.isSafeInteger(pull.number) || pull.number <= 0 || numbers.has(pull.number)) throw new Error("Pinned pull request numbers must be unique positive integers");
    numbers.add(pull.number);
    requireString(pull.nodeId, `sourceRepository.pullRequestsToClose[${index}].nodeId`);
    if (pull.state !== "open" || pull.baseRef !== "main") throw new Error(`Pull request #${pull.number} must pin open state and main base`);
    if (requireObjectId(pull.baseSha, `pull request #${pull.number} baseSha`) !== mainSha) throw new Error(`Pull request #${pull.number} baseSha does not match source main`);
    const headRef = requireString(pull.headRef, `pull request #${pull.number} headRef`);
    const headSha = requireObjectId(pull.headSha, `pull request #${pull.number} headSha`);
    if (heads.has(headRef) || branchMap.get(headRef) !== headSha) throw new Error(`Pull request #${pull.number} does not match one exact branch deletion`);
    heads.add(headRef);
  }
}

function validatePages(source, userSite, postconditionsValue) {
  const canonical = requireRecord(source.desiredPages, "sourceRepository.desiredPages");
  const legacy = requireRecord(userSite.desiredPages, "userSiteRepository.desiredPages");
  if (canonical.buildType !== "workflow" || canonical.cname !== null || canonical.httpsEnforced !== true) {
    throw new Error("Canonical Pages must pin workflow build, null CNAME, and HTTPS enforcement");
  }
  if (legacy.buildType !== "legacy" || legacy.cname !== null || legacy.httpsEnforced !== true) {
    throw new Error("Legacy Pages must pin legacy build, null CNAME, and HTTPS enforcement");
  }
  const legacySource = requireRecord(legacy.source, "userSiteRepository.desiredPages.source");
  if (legacySource.branch !== "main" || legacySource.path !== "/") throw new Error("Legacy Pages source must be main at /");
  const approvedName = requireString(source.approvedName, "sourceRepository.approvedName");
  const currentName = requireString(source.currentName, "sourceRepository.currentName");
  const userSiteName = requireString(userSite.name, "userSiteRepository.name");
  const [owner, approvedRepository, ...approvedExtra] = approvedName.split("/");
  const [currentOwner, currentRepository, ...currentExtra] = currentName.split("/");
  const [userSiteOwner, userSiteRepository, ...userSiteExtra] = userSiteName.split("/");
  if (!owner || !approvedRepository || approvedExtra.length || !currentOwner || !currentRepository || currentExtra.length || !userSiteOwner || !userSiteRepository || userSiteExtra.length || owner !== currentOwner || owner !== userSiteOwner) {
    throw new Error("Source and user-site repository names must be owner/repository pairs with the same owner");
  }
  if (userSiteRepository.toLowerCase() !== `${owner.toLowerCase()}.github.io`) {
    throw new Error("User-site repository must be the owner's root GitHub Pages repository");
  }
  const canonicalUrl = `https://${owner.toLowerCase()}.github.io/${approvedRepository}/`;
  const userSiteRootUrl = `https://${owner.toLowerCase()}.github.io/`;
  const legacyFeedUrl = `https://${owner.toLowerCase()}.github.io/${currentRepository}/`;
  if (canonical.url !== canonicalUrl) throw new Error("Desired canonical Pages URL does not match the approved repository rename");
  if (legacy.url !== userSiteRootUrl) throw new Error("Desired user-site Pages URL must be the owner's root Pages URL");
  const postconditions = requireRecord(postconditionsValue, "postconditions");
  if (postconditions.canonicalEndpoint !== canonicalUrl || postconditions.legacyEndpoint !== legacyFeedUrl) {
    throw new Error("Postcondition endpoints do not match desired Pages configuration");
  }
}

function validateCapturedInitialState(manifest, remoteSnapshotValue) {
  const captured = requireExactRecord(manifest.capturedInitialState, "capturedInitialState", ["sourceRepository", "userSiteRepository"]);
  const capturedSource = requireExactRecord(captured.sourceRepository, "capturedInitialState.sourceRepository", ["metadata", "pages"]);
  const capturedUserSite = requireExactRecord(captured.userSiteRepository, "capturedInitialState.userSiteRepository", ["pages"]);
  const source = requireRecord(manifest.sourceRepository, "sourceRepository");
  const userSite = requireRecord(manifest.userSiteRepository, "userSiteRepository");
  const postconditions = requireRecord(manifest.postconditions, "postconditions");

  const remoteSnapshot = requireRecord(remoteSnapshotValue, "localEvidence.remoteSnapshot JSON");
  if (remoteSnapshot.schemaVersion !== 1 || remoteSnapshot.readOnlyCapture !== true) {
    throw new Error("localEvidence.remoteSnapshot must be a schemaVersion 1 read-only capture");
  }
  const snapshotSource = requireRecord(remoteSnapshot.sourceRepository, "localEvidence.remoteSnapshot.sourceRepository");
  const snapshotUserSite = requireRecord(remoteSnapshot.userSiteRepository, "localEvidence.remoteSnapshot.userSiteRepository");
  validateSnapshotRepositoryIdentity(snapshotSource, {
    label: "sourceRepository",
    repositoryId: source.repositoryId,
    nodeId: source.nodeId,
    fullName: source.currentName,
  });
  validateSnapshotRepositoryIdentity(snapshotUserSite, {
    label: "userSiteRepository",
    repositoryId: userSite.repositoryId,
    nodeId: userSite.nodeId,
    fullName: userSite.name,
  });

  const capturedMetadata = normalizeRepositoryMetadata(capturedSource.metadata, "capturedInitialState.sourceRepository.metadata");
  const snapshotMetadata = normalizeRepositoryMetadata({
    description: snapshotSource.description,
    homepage: snapshotSource.homepage,
    topics: snapshotSource.topics,
  }, "localEvidence.remoteSnapshot.sourceRepository metadata");
  if (!isDeepStrictEqual(capturedMetadata, snapshotMetadata)) {
    throw new Error("capturedInitialState.sourceRepository.metadata does not match the hash-pinned remote snapshot");
  }
  const desiredMetadata = normalizeRepositoryMetadata(source.desiredMetadata, "sourceRepository.desiredMetadata");
  if (isDeepStrictEqual(capturedMetadata, desiredMetadata)) {
    throw new Error("sourceRepository.desiredMetadata must describe a change from capturedInitialState");
  }

  const legacyUrl = requireString(postconditions.legacyEndpoint, "postconditions.legacyEndpoint");
  const rootUrl = requireString(requireRecord(userSite.desiredPages, "userSiteRepository.desiredPages").url, "userSiteRepository.desiredPages.url");
  const capturedSourcePages = normalizePagesState(capturedSource.pages, "capturedInitialState.sourceRepository.pages", {
    branch: "gh-pages",
    url: legacyUrl,
  });
  const capturedUserSitePages = normalizePagesState(capturedUserSite.pages, "capturedInitialState.userSiteRepository.pages", {
    branch: "main",
    url: rootUrl,
  });
  const snapshotSourcePages = normalizeSnapshotPages(snapshotSource.pages, "localEvidence.remoteSnapshot.sourceRepository.pages", {
    branch: "gh-pages",
    url: legacyUrl,
  });
  const snapshotUserSitePages = normalizeSnapshotPages(snapshotUserSite.pages, "localEvidence.remoteSnapshot.userSiteRepository.pages", {
    branch: "main",
    url: rootUrl,
  });
  if (!isDeepStrictEqual(capturedSourcePages, snapshotSourcePages)) {
    throw new Error("capturedInitialState.sourceRepository.pages does not match the hash-pinned remote snapshot");
  }
  if (!isDeepStrictEqual(capturedUserSitePages, snapshotUserSitePages)) {
    throw new Error("capturedInitialState.userSiteRepository.pages does not match the hash-pinned remote snapshot");
  }

  const desiredUserSitePages = normalizePagesState(userSite.desiredPages, "userSiteRepository.desiredPages", {
    branch: "main",
    url: rootUrl,
  });
  if (!isDeepStrictEqual(capturedUserSitePages, desiredUserSitePages)) {
    throw new Error("userSiteRepository.desiredPages must preserve the captured user-site Pages configuration");
  }
  const desiredSourcePages = requireExactRecord(source.desiredPages, "sourceRepository.desiredPages", ["buildType", "cname", "httpsEnforced", "url"]);
  if (desiredSourcePages.buildType !== "workflow" || desiredSourcePages.cname !== null || desiredSourcePages.httpsEnforced !== true) {
    throw new Error("sourceRepository.desiredPages must pin workflow build, null CNAME, and HTTPS enforcement");
  }
  if (requireString(desiredSourcePages.url, "sourceRepository.desiredPages.url") === capturedSourcePages.url) {
    throw new Error("sourceRepository.desiredPages must move away from the captured legacy Pages URL");
  }
}

function validateSnapshotRepositoryIdentity(snapshot, expected) {
  const id = requirePositiveInteger(snapshot.id, `localEvidence.remoteSnapshot.${expected.label}.id`);
  const nodeId = requireString(snapshot.nodeId, `localEvidence.remoteSnapshot.${expected.label}.nodeId`);
  const fullName = requireString(snapshot.fullName, `localEvidence.remoteSnapshot.${expected.label}.fullName`);
  if (id !== expected.repositoryId || nodeId !== expected.nodeId || fullName !== expected.fullName) {
    throw new Error(`localEvidence.remoteSnapshot.${expected.label} identity does not match the manifest`);
  }
}

function normalizeRepositoryMetadata(value, label) {
  const metadata = requireExactRecord(value, label, ["description", "homepage", "topics"]);
  const topics = requireStringArray(metadata.topics, `${label}.topics`);
  if (new Set(topics).size !== topics.length) throw new Error(`${label}.topics contains duplicates`);
  return {
    description: requireNullableString(metadata.description, `${label}.description`),
    homepage: requireNullableString(metadata.homepage, `${label}.homepage`),
    topics,
  };
}

function normalizePagesState(value, label, expected) {
  const pages = requireExactRecord(value, label, ["buildType", "source", "cname", "httpsEnforced", "url"]);
  const source = requireExactRecord(pages.source, `${label}.source`, ["branch", "path"]);
  const normalized = {
    buildType: pages.buildType,
    source: {
      branch: requireString(source.branch, `${label}.source.branch`),
      path: requireString(source.path, `${label}.source.path`),
    },
    cname: pages.cname,
    httpsEnforced: pages.httpsEnforced,
    url: requireString(pages.url, `${label}.url`),
  };
  if (normalized.buildType !== "legacy" || normalized.source.branch !== expected.branch || normalized.source.path !== "/" || normalized.cname !== null || normalized.httpsEnforced !== true || normalized.url !== expected.url) {
    throw new Error(`${label} does not match the required legacy ${expected.branch} / Pages state`);
  }
  return normalized;
}

function normalizeSnapshotPages(value, label, expected) {
  const pages = requireRecord(value, label);
  const source = requireRecord(pages.source, `${label}.source`);
  return normalizePagesState({
    buildType: pages.buildType,
    source: { branch: source.branch, path: source.path },
    cname: pages.cname,
    httpsEnforced: pages.httpsEnforced,
    url: pages.htmlUrl,
  }, label, expected);
}

function validatePrerequisites(manifest) {
  const prerequisites = requireExactRecord(manifest.prerequisites, "prerequisites", [
    "ready", "releaseFreeze", "requiredEnvironments", "requiredVariables", "requiredEnvironmentSecrets", "requiredLegacyFeedApp", "missingAtCapture",
  ]);
  if (typeof prerequisites.ready !== "boolean") throw new Error("prerequisites.ready must be a boolean");
  if (manifest.approvalEligible !== prerequisites.ready) throw new Error("approvalEligible must equal prerequisites.ready");
  const freeze = requireExactRecord(prerequisites.releaseFreeze, "prerequisites.releaseFreeze", ["required", "activeReleaseWorkflowRunsAtCapture"]);
  const activeRuns = requireArray(freeze.activeReleaseWorkflowRunsAtCapture, "prerequisites.releaseFreeze.activeReleaseWorkflowRunsAtCapture");
  if (freeze.required !== true || activeRuns.length !== 0) throw new Error("Release freeze must require an empty captured active-run inventory");
  requireExactStringSet(prerequisites.requiredEnvironments, ["github-pages", "release-signing", "legacy-update-feed"], "prerequisites.requiredEnvironments");

  const variables = requireExactRecord(prerequisites.requiredVariables, "prerequisites.requiredVariables", [
    "UPDATER_FEED_MODE", "LEGACY_FEED_REPOSITORY", "LEGACY_FEED_APP_ID",
  ]);
  if (variables.UPDATER_FEED_MODE !== "dual" || variables.LEGACY_FEED_REPOSITORY !== manifest.userSiteRepository.name) {
    throw new Error("Required updater feed variables are not pinned to the dual-feed repositories");
  }
  const appId = requireString(variables.LEGACY_FEED_APP_ID, "prerequisites.requiredVariables.LEGACY_FEED_APP_ID");
  const appIdIsPositiveInteger = /^[1-9][0-9]*$/u.test(appId);
  if (!appIdIsPositiveInteger && appId !== "<numeric-dedicated-app-id>") {
    throw new Error("LEGACY_FEED_APP_ID must be a positive decimal integer or the exact ineligible placeholder");
  }
  if (prerequisites.ready && !appIdIsPositiveInteger) throw new Error("Ready prerequisites must pin a positive decimal LEGACY_FEED_APP_ID");

  const environmentSecrets = requireExactRecord(prerequisites.requiredEnvironmentSecrets, "prerequisites.requiredEnvironmentSecrets", ["release-signing", "legacy-update-feed"]);
  requireExactStringSet(environmentSecrets["release-signing"], ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"], "prerequisites.requiredEnvironmentSecrets.release-signing");
  requireExactStringSet(environmentSecrets["legacy-update-feed"], ["LEGACY_FEED_APP_PRIVATE_KEY"], "prerequisites.requiredEnvironmentSecrets.legacy-update-feed");

  const app = requireExactRecord(prerequisites.requiredLegacyFeedApp, "prerequisites.requiredLegacyFeedApp", ["installedOnlyOn", "permissions"]);
  const permissions = requireExactRecord(app.permissions, "prerequisites.requiredLegacyFeedApp.permissions", ["metadata", "contents"]);
  if (app.installedOnlyOn !== manifest.userSiteRepository.name || permissions.metadata !== "read" || permissions.contents !== "write") {
    throw new Error("Dedicated legacy-feed App must select only the user-site repository with Metadata read and Contents write");
  }
  const missing = requireStringArray(prerequisites.missingAtCapture, "prerequisites.missingAtCapture");
  if (new Set(missing).size !== missing.length) throw new Error("prerequisites.missingAtCapture contains duplicates");
  if (prerequisites.ready && missing.length !== 0) throw new Error("Ready prerequisites must have no captured gaps");
  if (!prerequisites.ready && missing.length === 0) throw new Error("Unready prerequisites must list the captured gaps");
}

function validateDeferredGates(value, source) {
  const deferredGates = requireExactRecord(value, "deferredGates", ["repositoryProtections"]);
  const protections = requireExactRecord(deferredGates.repositoryProtections, "deferredGates.repositoryProtections", [
    "phase",
    "sourceRepositoryId",
    "branch",
    "executorMustNotConfigureOrClaimCompletion",
    "separatePolicyAndVerificationRequired",
    "blocksSignedV0.12Publication",
    "blocksDesktopInstallation",
  ]);
  const expected = {
    phase: "post-cutover-pre-release",
    sourceRepositoryId: source.repositoryId,
    branch: "main",
    executorMustNotConfigureOrClaimCompletion: true,
    separatePolicyAndVerificationRequired: true,
    "blocksSignedV0.12Publication": true,
    blocksDesktopInstallation: true,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (protections[key] !== expectedValue) throw new Error(`deferredGates.repositoryProtections.${key} must be ${JSON.stringify(expectedValue)}`);
  }
}

function validateExecution(value, context) {
  const execution = requireRecord(value, "execution");
  if (execution.stateMachineVersion !== 1) throw new Error("execution.stateMachineVersion must be 1");
  requireSafeRelativePath(execution.journalPath, "execution.journalPath");
  const resumePolicy = requireString(execution.resumePolicy, "execution.resumePolicy");
  if (!/exact/iu.test(resumePolicy) || !/journal/iu.test(resumePolicy) || !/abort/iu.test(resumePolicy)) {
    throw new Error("execution.resumePolicy must describe exact, journaled, fail-closed recovery");
  }
  const steps = requireArray(execution.steps, "execution.steps");
  const expectedKinds = new Map([
    ["preflight", "read-only"],
    ["user-site-main", "exact-cas"],
    ["source-refs", "atomic-source-refs"],
    ["rename", "same-repository-rename"],
    ["close-pull-requests", "pinned-idempotent-pr-close"],
    ["metadata-and-pages", "exact-config"],
    ["verify", "read-only"],
  ]);
  if (steps.length !== expectedKinds.size) throw new Error("Execution state machine must contain the seven pinned cutover steps");
  if (JSON.stringify(steps.map((step) => step?.id)) !== JSON.stringify([...expectedKinds.keys()])) {
    throw new Error("Execution steps must remain in the pinned forward-only order");
  }
  const stepMap = new Map();
  for (const [index, rawStep] of steps.entries()) {
    const step = requireRecord(rawStep, `execution.steps[${index}]`);
    const id = requireString(step.id, `execution.steps[${index}].id`);
    const kind = requireString(step.kind, `execution.steps[${index}].kind`);
    if (stepMap.has(id) || expectedKinds.get(id) !== kind) throw new Error(`Unexpected or duplicate execution step: ${id}`);
    if (containsProtectionClaim(step)) throw new Error(`Execution step ${id} may not configure or claim completion of repository protections or rulesets`);
    stepMap.set(id, step);
  }
  const atomicSteps = steps.filter((step) => step.kind === "atomic-source-refs");
  if (atomicSteps.length !== 1) throw new Error("Execution must contain exactly one atomic-source-refs step");
  const atomic = atomicSteps[0];
  if (atomic.repositoryId !== context.source.repositoryId) throw new Error("Atomic source-ref step targets the wrong repository ID");
  const includes = requireStringArray(atomic.includes, "atomic source-ref includes");
  for (const ref of ["refs/heads/main", "refs/heads/gh-pages", "refs/tags/v0.8.3"]) {
    if (!includes.includes(ref)) throw new Error(`Atomic source-ref step does not include ${ref}`);
  }
  const deletionSummary = includes.find((entry) => / exact branch deletions$/u.test(entry));
  if (!deletionSummary || parseCount(deletionSummary.split(" ", 1)[0]) !== context.branchCount) {
    throw new Error("Atomic source-ref step does not pin the exact branch deletion count");
  }
  const siteStep = stepMap.get("user-site-main");
  if (siteStep.repositoryId !== context.userSite.repositoryId || siteStep.ref !== "refs/heads/main" || siteStep.expectedOld !== context.userMain.expectedOld || siteStep.approvedNew !== context.userMain.approvedNew) {
    throw new Error("User-site exact-CAS step does not match the pinned user-site update");
  }
  const rename = stepMap.get("rename");
  if (rename.repositoryId !== context.source.repositoryId || rename.expectedOld !== context.source.currentName || rename.approvedNew !== context.source.approvedName) {
    throw new Error("Rename step does not match the pinned same-repository rename");
  }
  const pullNumbers = context.source.pullRequestsToClose.map((pull) => pull.number).sort((a, b) => a - b);
  const closeNumbers = requireArray(stepMap.get("close-pull-requests").numbers, "close-pull-requests.numbers").slice().sort((a, b) => a - b);
  if (JSON.stringify(closeNumbers) !== JSON.stringify(pullNumbers)) throw new Error("PR-close step does not match pinned pull request metadata");
  for (const id of ["preflight", "metadata-and-pages", "verify"]) {
    requireString(stepMap.get(id).postcondition, `${id}.postcondition`);
  }
}

function containsProtectionClaim(value) {
  if (typeof value === "string") return /\b(?:protections?|rulesets?)\b/iu.test(value);
  if (Array.isArray(value)) return value.some(containsProtectionClaim);
  if (isRecord(value)) return Object.entries(value).some(([key, entry]) => containsProtectionClaim(key) || containsProtectionClaim(entry));
  return false;
}

function validateRequiredBeforeMutation(value) {
  const requirements = requireStringArray(value, "requiredBeforeMutation");
  const mentionsDerivedPhrase = requirements.some((entry) => entry.includes(APPROVAL_PREFIX) && /lowercase SHA-256/iu.test(entry) && /file|manifest/iu.test(entry));
  if (!mentionsDerivedPhrase) throw new Error("requiredBeforeMutation must require the manifest-hash-derived approval phrase");
}

function validateForbidden(value) {
  const forbidden = requireStringArray(value, "forbidden");
  const requirements = [
    /development repository|private checkpoint/iu,
    /plain force|broaden.*lease/iu,
    /recreate.*tasty-desktop/iu,
    /delete or replace.*Release|Release.*assets/iu,
    /install or restart/iu,
  ];
  for (const requirement of requirements) {
    if (!forbidden.some((entry) => requirement.test(entry))) throw new Error(`forbidden is missing safety contract ${requirement}`);
  }
}

function validatePostconditions(value, releaseValue) {
  const postconditions = requireRecord(value, "postconditions");
  for (const key of ["releaseRecordAndAssetsUnchanged", "oldRepositoryNameRemainsUnclaimed", "signedV0.12PublicationIsSeparate", "desktopInstallationIsSeparate"]) {
    if (postconditions[key] !== true) throw new Error(`postconditions.${key} must be true`);
  }
  const release = requireRecord(releaseValue, "release");
  requirePositiveInteger(release.id, "release.id");
  if (release.tag !== "v0.8.3" || release.preserveRecordAndAssets !== true || release.signatureVerified !== true) {
    throw new Error("Release record, assets, tag, and verified signature must be pinned for preservation");
  }
  const rawAssets = requireArray(release.assets, "release.assets");
  if (rawAssets.length !== 4) throw new Error("release.assets must pin exactly four v0.8.3 assets");
  const assetIds = new Set();
  const assets = rawAssets.map((entry, index) => {
    const asset = requireRecord(entry, `release.assets[${index}]`);
    const id = requirePositiveInteger(asset.id, `release.assets[${index}].id`);
    if (assetIds.has(id)) throw new Error(`Duplicate Release asset ID: ${id}`);
    assetIds.add(id);
    return normalizeFeedFile(asset, `release.assets[${index}]`);
  });
  const feedFiles = requireArray(postconditions.feedFiles, "postconditions.feedFiles").map((entry, index) => normalizeFeedFile(entry, `postconditions.feedFiles[${index}]`));
  const sortFiles = (left, right) => left.name.localeCompare(right.name);
  assets.sort(sortFiles);
  feedFiles.sort(sortFiles);
  if (JSON.stringify(assets) !== JSON.stringify(feedFiles)) throw new Error("Postcondition feed files do not exactly match pinned Release assets");
}

function normalizeFeedFile(value, label) {
  const file = requireRecord(value, label);
  const name = requireString(file.name, `${label}.name`);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`${label}.bytes must be a non-negative safe integer`);
  return { name, bytes: file.bytes, sha256: requireSha256(file.sha256, `${label}.sha256`) };
}

function collectArtifactRecords(manifest) {
  const records = [];
  const backups = requireArray(manifest.privateBackups, "privateBackups");
  for (const [index, value] of backups.entries()) records.push(normalizeArtifact(value, `privateBackups[${index}]`));
  const evidence = requireRecord(manifest.localEvidence, "localEvidence");
  records.push(normalizeArtifact(evidence.migrationEvidence, "localEvidence.migrationEvidence"));
  records.push(normalizeArtifact(evidence["sanitizedV0.8.3Evidence"], "localEvidence.sanitizedV0.8.3Evidence"));
  records.push(normalizeArtifact(evidence.sourceZip, "localEvidence.sourceZip"));
  records.push(normalizeArtifact(evidence.remoteSnapshot, "localEvidence.remoteSnapshot"));
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.path)) throw new Error(`Duplicate local artifact path: ${record.path}`);
    seen.add(record.path);
  }
  return records;
}

function normalizeArtifact(value, label) {
  const artifact = requireRecord(value, label);
  const path = requireSafeRelativePath(artifact.path, `${label}.path`);
  const expectedHash = requireSha256(artifact.sha256, `${label}.sha256`);
  if (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) {
    throw new Error(`${label}.bytes must be a non-negative safe integer`);
  }
  return { label, path, bytes: artifact.bytes, sha256: expectedHash };
}

async function verifyArtifact(root, record) {
  const path = await resolveContainedPath(root, record.path, record.label, false);
  const actual = await readPinnedFile(path, { label: record.label });
  if (record.bytes !== undefined && actual.size !== record.bytes) {
    throw new Error(`${record.label} size mismatch: expected ${record.bytes}, found ${actual.size}`);
  }
  const actualHash = sha256(actual.bytes);
  if (actualHash !== record.sha256) throw new Error(`${record.label} SHA-256 mismatch: expected ${record.sha256}, found ${actualHash}`);
  return {
    bytes: actual.bytes,
    result: { label: record.label, path, bytes: actual.size, sha256: actualHash },
  };
}

async function verifyRepository(specification) {
  const { label, path, branch, commit, tree, parent, expectedRefs, tag } = specification;
  const topLevel = resolve((await runGit(["rev-parse", "--show-toplevel"], path)).stdout.trim());
  if (await realpath(topLevel) !== path) throw new Error(`${label} is not the repository root`);
  if ((await runGit(["rev-parse", "--is-bare-repository"], path)).stdout.trim() !== "false") throw new Error(`${label} must be a working-tree repository`);
  await assertRepositoryIsOffline(path, label);
  const headRef = (await runGit(["symbolic-ref", "--quiet", "HEAD"], path)).stdout.trim();
  if (headRef !== `refs/heads/${branch}`) throw new Error(`${label} HEAD must point to refs/heads/${branch}`);
  const head = (await runGit(["rev-parse", "--verify", "HEAD"], path)).stdout.trim();
  if (head !== commit) throw new Error(`${label} ref mismatch: expected ${commit}, found ${head}`);
  const type = (await runGit(["cat-file", "-t", commit], path)).stdout.trim();
  if (type !== "commit") throw new Error(`${label} approved object is not a commit`);
  const actualTree = (await runGit(["rev-parse", "--verify", `${commit}^{tree}`], path)).stdout.trim();
  if (actualTree !== tree) throw new Error(`${label} tree mismatch: expected ${tree}, found ${actualTree}`);
  const commitObject = (await runGit(["cat-file", "-p", commit], path)).stdout;
  const parents = commitObject.split(/\r?\n/u).filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  const expectedParents = parent === null ? [] : [parent];
  if (JSON.stringify(parents) !== JSON.stringify(expectedParents)) {
    throw new Error(`${label} parent mismatch: expected ${parent ?? "parentless"}, found ${parents.join(", ") || "parentless"}`);
  }

  const refs = await readRefs(path);
  if (refs.size !== expectedRefs.size) throw new Error(`${label} has unexpected refs`);
  for (const [ref, expected] of expectedRefs) {
    const actual = refs.get(ref);
    if (!actual || actual.object !== expected.object || actual.type !== expected.type) throw new Error(`${label} ref mismatch for ${ref}`);
  }
  if ([...refs.keys()].some((ref) => ref.startsWith("refs/remotes/"))) throw new Error(`${label} has remote-tracking refs`);
  const status = (await runGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], path)).stdout;
  if (status.trim()) throw new Error(`${label} is not clean: ${status.trim().split(/\r?\n/u)[0]}`);

  if (tag) {
    const tagType = (await runGit(["cat-file", "-t", tag.object], path)).stdout.trim();
    if (tagType !== "tag") throw new Error(`${label} ${tag.name} must be an annotated tag object`);
    const tagBody = (await runGit(["cat-file", "-p", tag.object], path)).stdout;
    const tagObject = tagBody.match(/^object ([0-9a-f]{40})$/mu)?.[1];
    const tagTargetType = tagBody.match(/^type (\S+)$/mu)?.[1];
    const tagName = tagBody.match(/^tag (.+)$/mu)?.[1];
    if (tagObject !== tag.commit || tagTargetType !== "commit" || tagName !== tag.name) throw new Error(`${label} annotated tag does not point to the approved commit`);
  }

  const fsck = await runGit(["fsck", "--full", "--strict", "--no-reflogs", "--no-progress"], path);
  if (fsck.stdout.trim() || fsck.stderr.trim()) throw new Error(`${label} fsck produced unexpected output: ${message(fsck.stderr || fsck.stdout)}`);
  return { path, branch, commit, tree, parent, tagObject: tag?.object ?? null, refs: [...refs.keys()].sort(), fsck: "clean" };
}

async function assertRepositoryIsOffline(repository, label) {
  const configuredNetwork = await runGit(["config", "--local", "--get-regexp", "^(remote\\.|extensions\\.partialclone$)"], repository, [0, 1]);
  if (configuredNetwork.code === 0 || configuredNetwork.stdout.trim() || configuredNetwork.stderr.trim()) throw new Error(`${label} has a configured remote or partial-clone source`);
  if ((await runGit(["rev-parse", "--is-shallow-repository"], repository)).stdout.trim() !== "false") throw new Error(`${label} must not be shallow`);
  for (const name of ["objects/info/alternates", "objects/info/http-alternates"]) {
    const path = (await runGit(["rev-parse", "--git-path", name], repository)).stdout.trim();
    const entry = await lstat(resolve(repository, path)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw new Error(`${label} alternate-object configuration is unavailable: ${message(error)}`);
    });
    if (entry) throw new Error(`${label} has alternate object storage configured`);
  }
}

async function readRefs(repository) {
  const output = (await runGit(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(objecttype)"], repository)).stdout;
  const refs = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const [ref, object, type, ...extra] = line.split("\t");
    if (extra.length || !ref || !OBJECT_ID.test(object) || !new Set(["commit", "tag"]).has(type) || refs.has(ref)) throw new Error(`Invalid local Git ref record: ${line}`);
    refs.set(ref, { object, type });
  }
  return refs;
}

function assertRepositoryEvidence(repositories, actual) {
  for (const [key, result] of Object.entries(actual)) {
    const evidence = repositories[key];
    if (evidence.branch !== result.branch || evidence.commit !== result.commit || evidence.tree !== result.tree || evidence.parent !== result.parent) {
      throw new Error(`localEvidence.repositories.${key} does not match the verified repository`);
    }
  }
  const tagEvidence = repositories["sanitizedV0.8.3"];
  if (tagEvidence.tag !== "v0.8.3" || tagEvidence.tagObject !== actual["sanitizedV0.8.3"].tagObject) {
    throw new Error("Sanitized tag evidence does not match the verified repository");
  }
}

function approvalMissingItems(manifest) {
  const missing = [...manifest.prerequisites.missingAtCapture];
  if (manifest.prerequisites.ready !== true) missing.push("prerequisites.ready is false");
  if (manifest.approvalEligible !== true) missing.push("approvalEligible is false");
  if (manifest.lastRemoteFreezeMatched !== true) missing.push("lastRemoteFreezeMatched is not true");
  return [...new Set(missing)];
}

function validateHashFields(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateHashFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (/sha256$/iu.test(key)) requireSha256(entry, `${path}.${key}`);
    validateHashFields(entry, `${path}.${key}`);
  }
}

function validateGitObjectFields(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateGitObjectFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  const objectFields = new Set([
    "approvedNewCommit", "approvedNewTagObject", "approvedNewTree", "approvedTree", "baseSha", "capturedHead",
    "commit", "expectedOldCommit", "expectedOldTagObject", "expectedOldTree", "headSha", "tagObject", "tree",
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (objectFields.has(key)) requireObjectId(entry, `${path}.${key}`);
    if (key === "parent" && entry !== null) requireObjectId(entry, `${path}.parent`);
    validateGitObjectFields(entry, `${path}.${key}`);
  }
}

async function resolveContainedPath(root, relativePath, label, directory) {
  requireSafeRelativePath(relativePath, `${label} path`);
  const candidate = resolve(root, relativePath);
  const actual = directory ? await requireDirectory(candidate, label) : await requireRegularPath(candidate, label);
  const containment = relative(root, actual);
  if (!containment || (!containment.startsWith(`..${sep}`) && containment !== ".." && !isAbsolute(containment))) return actual;
  throw new Error(`${label} resolves outside the artifact root`);
}

async function requireDirectory(path, label) {
  const entry = await lstat(path).catch((error) => { throw new Error(`${label} is unavailable: ${message(error)}`); });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  return realpath(path);
}

async function requireRegularPath(path, label) {
  const entry = await lstat(path).catch((error) => { throw new Error(`${label} is unavailable: ${message(error)}`); });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return realpath(path);
}

async function readPinnedFile(path, { label, maxBytes = Number.MAX_SAFE_INTEGER }) {
  const actualPath = await requireRegularPath(path, label);
  const handle = await open(actualPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error(`${label} exceeds the allowed size`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`${label} changed while it was being read`);
    return { path: actualPath, bytes, size: before.size };
  } finally {
    await handle.close();
  }
}

async function runGit(args, repository, allowedExitCodes = [0]) {
  const command = args[0];
  if (!ALLOWED_GIT_COMMANDS.has(command)) throw new Error(`Disallowed local Git command: ${command}`);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    const result = await execFileAsync("git", ["--no-optional-locks", "--no-replace-objects", "-c", `safe.directory=${repository}`, "-c", "core.fsmonitor=false", ...args], {
      cwd: repository,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const code = Number(error?.code);
    if (allowedExitCodes.includes(code)) return { code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw new Error(`Local Git ${command} failed: ${message(error?.stderr || error?.stdout || error)}`);
  }
}

function requireObjectId(value, label) {
  if (!OBJECT_ID.test(value)) throw new Error(`${label} must be a 40-character lowercase Git object ID`);
  return value;
}

function requireSha256(value, label) {
  if (!SHA256.test(value)) throw new Error(`${label} must be a 64-character lowercase SHA-256`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function requireSafeRelativePath(value, label) {
  const path = requireString(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`${label} must be a safe portable relative path`);
  }
  return path;
}

function requireStringArray(value, label) {
  const array = requireArray(value, label);
  return array.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function requireExactStringSet(value, expected, label) {
  const actual = requireStringArray(value, label);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((entry) => !actual.includes(entry))) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return actual;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireExactRecord(value, label, expectedKeys) {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  return record;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a non-empty single-line string`);
  return value;
}

function requireNullableString(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a single-line string or null`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCount(value) {
  const words = new Map([["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10]]);
  if (/^(?:0|[1-9]\d*)$/u.test(value)) return Number(value);
  return words.get(value.toLowerCase());
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function message(value) {
  return value instanceof Error ? value.message : String(value).trim();
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function parseArguments(values) {
  let mode = "inspect";
  let offset = 0;
  if (values[0] && !values[0].startsWith("--")) {
    mode = values[0];
    offset = 1;
  }
  const options = { mode };
  for (let index = offset; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    const property = key.slice(2).replace(/-([a-z0-9])/gu, (_match, character) => character.toUpperCase());
    if (Object.hasOwn(options, property)) throw new Error(`Duplicate argument: ${key}`);
    options[property] = value;
  }
  return options;
}

async function runCli() {
  const result = await checkMigrationApproval(parseArguments(process.argv.slice(2)));
  if (result.mode === "approve") {
    console.log(result.approvalPhrase);
    return;
  }
  if (result.eligible) {
    console.log("ELIGIBLE");
    return;
  }
  console.log("NOT ELIGIBLE");
  for (const item of result.missing) console.log(`- ${item}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
