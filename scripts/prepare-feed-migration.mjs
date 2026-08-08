import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, lstat, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const CURRENT_FILES = new Set(["latest.json", "SHA256SUMS.txt"]);
const HISTORICAL_INSTALLER = /^Kimi-Code(?:-Desktop)?-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-x64-setup\.exe$/u;
const OBJECT_ID = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NOREPLY = /^[^@\s]+@users\.noreply\.github\.com$/iu;
const ALLOWED_GIT_COMMANDS = new Set([
  "bundle",
  "cat-file",
  "commit-tree",
  "for-each-ref",
  "fsck",
  "hash-object",
  "init",
  "ls-tree",
  "rev-list",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
  "update-index",
  "update-ref",
  "write-tree",
]);

export async function prepareFeedMigration(input) {
  const options = normalizeOptions(input);
  await assertFreshOutput(options.canonicalOutput);
  await assertFreshOutput(options.userSiteOutput);
  await assertFreshFile(options.evidenceOutput);

  const sources = await loadSources(options);
  const canonicalFiles = buildCanonicalFiles(sources);
  const userSiteFiles = buildUserSiteFiles(sources);
  let canonicalCreated = false;
  let userSiteCreated = false;
  let evidenceCreated = false;

  try {
    await claimOutputDirectory(options.canonicalOutput);
    canonicalCreated = true;
    await claimOutputDirectory(options.userSiteOutput);
    userSiteCreated = true;
    await createCanonicalRepairRepository(
      options.canonicalOutput,
      sources.product.repository,
      options.productGhPagesSha,
      sources.productTree,
      canonicalFiles,
      options.identity,
    );
    await createRootRepository(options.userSiteOutput, "main", userSiteFiles, options.identity, "Seed Kimi Code compatibility feed");

    const evidence = await computeEvidence(options, sources, canonicalFiles, userSiteFiles);
    await mkdir(dirname(options.evidenceOutput), { recursive: true });
    await writeFile(options.evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    evidenceCreated = true;
    const verification = await verifyFeedMigration(input);
    return { ...verification, evidenceSha256: await sha256File(options.evidenceOutput) };
  } catch (error) {
    if (evidenceCreated) await rm(options.evidenceOutput, { force: true });
    if (userSiteCreated) await removeTree(options.userSiteOutput);
    if (canonicalCreated) await removeTree(options.canonicalOutput);
    throw error;
  } finally {
    await sources.close();
  }
}

export async function verifyFeedMigration(input) {
  const options = normalizeOptions(input);
  const sources = await loadSources(options);
  try {
    const canonicalFiles = buildCanonicalFiles(sources);
    const userSiteFiles = buildUserSiteFiles(sources);
    const expected = await computeEvidence(options, sources, canonicalFiles, userSiteFiles);
    const storedBytes = await readBoundedFile(options.evidenceOutput, 2 * 1024 * 1024, "migration evidence");
    if (storedBytes[0] === 0xef && storedBytes[1] === 0xbb && storedBytes[2] === 0xbf) {
      throw new Error("Migration evidence must be UTF-8 without a BOM");
    }
    const storedText = storedBytes.toString("utf8");
    if (!storedText.endsWith("\n") || storedText.endsWith("\n\n")) {
      throw new Error("Migration evidence must end in exactly one LF");
    }
    let stored;
    try {
      stored = JSON.parse(storedText);
    } catch (error) {
      throw new Error(`Migration evidence is not valid JSON: ${message(error)}`);
    }
    if (!isDeepStrictEqual(stored, expected)) throw new Error("Migration evidence does not match the recomputed local state");
    return {
      canonicalCommit: expected.outputs.canonical.commit,
      userSiteCommit: expected.outputs.userSite.commit,
      evidenceSha256: await sha256File(options.evidenceOutput),
      version: expected.release.version,
    };
  } finally {
    await sources.close();
  }
}

async function loadSources(options) {
  const [product, userSite] = await Promise.all([
    openBundle(options.productBundle, options.productBundleSha256, "refs/heads/gh-pages", options.productGhPagesSha),
    openBundle(options.userSiteBundle, options.userSiteBundleSha256, "refs/heads/main", options.userSiteMainSha),
  ]);
  try {
    const [productTree, userSiteTree, releaseFiles, publicKey] = await Promise.all([
      readGitTree(product.repository, options.productGhPagesSha),
      readGitTree(userSite.repository, options.userSiteMainSha),
      readReleaseDirectory(options.releaseDirectory),
      readUpdaterPublicKey(options.tauriConfig),
    ]);
    const release = validateLegacyFeed(releaseFiles, { label: "Release capture", exact: true });
    const pages = validateLegacyFeed(productTree, { label: "canonical gh-pages capture", exact: false });
    assertReleaseAndPagesEquivalent(release, pages);
    const signatureEvidence = await validateSignatureEvidence(
      options.signatureEvidence,
      options.signatureEvidenceSha256,
      release,
      publicKey,
    );
    const cryptographicVerification = await runUpdaterSignatureVerifier(options, release, publicKey);
    assertPagesTreeShape(productTree, pages);
    assertTreeSafe(userSiteTree, "user-site source tree");
    return {
      product,
      userSite,
      productTree,
      userSiteTree,
      release,
      pages,
      publicKey,
      signatureEvidence,
      cryptographicVerification,
      close: async () => Promise.all([product.close(), userSite.close()]),
    };
  } catch (error) {
    await Promise.all([product.close(), userSite.close()]);
    throw error;
  }
}

async function openBundle(path, expectedHash, requiredRef, expectedObject) {
  await assertRegularFile(path, "backup bundle");
  const hash = await sha256File(path);
  if (hash !== expectedHash) throw new Error(`Backup bundle hash mismatch for ${basename(path)}: expected ${expectedHash}, found ${hash}`);
  const repository = await mkdtemp(join(tmpdir(), "kimi-feed-migration-bundle-"));
  try {
    await runGit(["init", "--bare", "--quiet", repository], dirname(repository), repository);
    await runGit(["bundle", "verify", path], repository);
    const listed = await runGit(["bundle", "list-heads", path], repository);
    const heads = parseBundleHeads(listed.stdout);
    if (heads.get(requiredRef) !== expectedObject) {
      throw new Error(`Bundle ${basename(path)} does not contain ${requiredRef} at ${expectedObject}`);
    }
    await runGit(["bundle", "unbundle", path], repository);
    const type = (await runGit(["cat-file", "-t", expectedObject], repository)).stdout.trim();
    if (type !== "commit") throw new Error(`Observed object ${expectedObject} is not a commit in ${basename(path)}`);
    return {
      repository,
      path,
      hash,
      size: (await stat(path)).size,
      heads: [...heads].map(([ref, object]) => ({ ref, object })).sort((left, right) => left.ref.localeCompare(right.ref)),
      requiredRef,
      observedObject: expectedObject,
      close: () => removeTree(repository),
    };
  } catch (error) {
    await removeTree(repository);
    throw error;
  }
}

function parseBundleHeads(output) {
  const heads = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf(" ");
    const object = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (separator !== 40 || !OBJECT_ID.test(object) || !ref || heads.has(ref)) throw new Error(`Invalid bundle head: ${line}`);
    heads.set(ref, object);
  }
  if (heads.size === 0) throw new Error("Backup bundle contains no advertised refs");
  return heads;
}

async function readGitTree(repository, commit) {
  const output = (await runGit(["ls-tree", "-r", "-z", "--full-tree", commit], repository, repository, null)).stdout;
  const entries = new Map();
  for (const record of splitNul(output)) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Invalid Git tree record");
    const header = record.subarray(0, tab).toString("ascii").split(" ");
    const path = record.subarray(tab + 1).toString("utf8");
    const [mode, type, object, ...extra] = header;
    validateRepositoryPath(path);
    if (extra.length || type !== "blob" || !["100644", "100755"].includes(mode) || !OBJECT_ID.test(object)) {
      throw new Error(`Unsupported Git tree entry: ${mode} ${type} ${object} ${path}`);
    }
    const bytes = (await runGit(["cat-file", "blob", object], repository, repository, null)).stdout;
    entries.set(path, { path, mode, object, bytes });
  }
  assertNoPathCollisions(entries.keys());
  return entries;
}

async function readReleaseDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Release capture must contain regular files only: ${entry.name}`);
    validateRepositoryPath(entry.name);
    const path = join(directory, entry.name);
    files.set(entry.name, { path: entry.name, mode: "100644", bytes: await readFile(path) });
  }
  return files;
}

function validateLegacyFeed(files, { label, exact }) {
  const latestEntry = requiredEntry(files, "latest.json", label);
  const checksumEntry = requiredEntry(files, "SHA256SUMS.txt", label);
  const latestText = latestEntry.bytes.toString("utf8");
  if (latestText.startsWith("\uFEFF")) throw new Error(`${label} latest.json has a BOM`);
  let manifest;
  try {
    manifest = JSON.parse(latestText);
  } catch (error) {
    throw new Error(`${label} latest.json is invalid: ${message(error)}`);
  }
  assertExactKeys(manifest, ["platforms", "notes", "version", "pub_date"], `${label} manifest`);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(manifest.version)) {
    throw new Error(`${label} has an invalid stable version`);
  }
  if (![`Kimi Code Desktop ${manifest.version}`, `Kimi Code ${manifest.version}`].includes(manifest.notes)) {
    throw new Error(`${label} has unexpected release notes`);
  }
  if (!Number.isFinite(new Date(manifest.pub_date).valueOf())) throw new Error(`${label} has an invalid publication date`);
  assertExactKeys(manifest.platforms, ["windows-x86_64"], `${label} platforms`);
  const platform = manifest.platforms["windows-x86_64"];
  assertExactKeys(platform, ["signature", "url"], `${label} Windows platform`);
  const installerName = installerNameFromUrl(platform.url);
  if (!HISTORICAL_INSTALLER.test(installerName)) throw new Error(`${label} has an unsupported installer name: ${installerName}`);
  const signatureName = `${installerName}.sig`;
  const installerEntry = requiredEntry(files, installerName, label);
  const signatureEntry = requiredEntry(files, signatureName, label);
  const signatureText = canonicalBase64Text(signatureEntry.bytes, `${label} detached signature`);
  if (platform.signature !== signatureText) throw new Error(`${label} manifest signature differs from its detached signature`);
  const checksum = parseChecksum(checksumEntry.bytes, label);
  if (checksum.name !== installerName) throw new Error(`${label} checksum names ${checksum.name}, not ${installerName}`);
  const installerHash = sha256Bytes(installerEntry.bytes);
  if (checksum.hash !== installerHash) throw new Error(`${label} installer checksum mismatch`);

  const currentNames = [installerName, signatureName, "latest.json", "SHA256SUMS.txt"];
  if (exact && (files.size !== currentNames.length || currentNames.some((name) => !files.has(name)))) {
    throw new Error(`${label} must contain exactly its four current files`);
  }
  return { label, manifest, installerName, signatureName, installerHash, signatureText, checksum, currentNames, files };
}

function installerNameFromUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Updater manifest URL is invalid");
  }
  if (url.protocol !== "https:" || url.search || url.hash) throw new Error(`Unsupported updater URL: ${input}`);
  const allowed = url.hostname === "leonxlnx.github.io"
    ? /^\/(?:kimi-code-desktop|tasty-desktop)\/[^/]+$/u.test(url.pathname)
    : url.hostname === "github.com" && /^\/Leonxlnx\/(?:kimi-code-desktop|tasty-desktop)\/releases\/download\/v\d+\.\d+\.\d+\/[^/]+$/u.test(url.pathname);
  if (!allowed) throw new Error(`Unsupported updater URL: ${input}`);
  return decodeURIComponent(basename(url.pathname));
}

function assertReleaseAndPagesEquivalent(release, pages) {
  if (!isDeepStrictEqual(release.manifest, pages.manifest)) {
    throw new Error("Release and canonical Pages manifests are not semantically identical");
  }
  if (!isDeepStrictEqual(release.checksum, pages.checksum)) {
    throw new Error("Release and canonical Pages checksums are not semantically identical");
  }
  for (const name of [release.installerName, release.signatureName]) {
    if (!requiredEntry(release.files, name, release.label).bytes.equals(requiredEntry(pages.files, name, pages.label).bytes)) {
      throw new Error(`Release and canonical Pages bytes differ for ${name}`);
    }
  }
}

function assertPagesTreeShape(files, feed) {
  requiredEntry(files, ".nojekyll", feed.label);
  for (const path of files.keys()) {
    if (path === ".nojekyll" || feed.currentNames.includes(path) || historicalAssetKind(path)) continue;
    throw new Error(`Unexpected canonical Pages file: ${path}`);
  }
  collectHistoricalPairs(files, feed.currentNames);
}

function buildCanonicalFiles(sources) {
  const output = new Map();
  addEntry(output, ".nojekyll", requiredEntry(sources.productTree, ".nojekyll", "canonical gh-pages capture"));
  for (const name of sources.release.currentNames) addEntry(output, name, requiredEntry(sources.release.files, name, sources.release.label));
  for (const [path, entry] of collectHistoricalPairs(sources.productTree, sources.pages.currentNames)) addEntry(output, path, entry);
  for (const [path, entry] of collectUserSiteHistoricalPairs(sources.userSiteTree, sources.pages.currentNames)) addEntry(output, path, entry);
  assertNoPathCollisions(output.keys());
  return output;
}

function buildUserSiteFiles(sources) {
  const output = new Map();
  addEntry(output, ".nojekyll", { mode: "100644", bytes: Buffer.alloc(0) });
  let cnameCount = 0;
  for (const [path, entry] of sources.userSiteTree) {
    if (!path.includes("/") && path.toLocaleLowerCase("en-US") === "cname") {
      cnameCount += 1;
      continue;
    }
    if (path === "tasty-desktop" || path.startsWith("tasty-desktop/")) continue;
    addEntry(output, path, entry);
  }
  if (cnameCount > 1) throw new Error("User-site source contains multiple case-equivalent CNAME files");
  const canonical = buildCanonicalFiles(sources);
  for (const [path, entry] of canonical) {
    if (path === ".nojekyll") continue;
    addEntry(output, `tasty-desktop/${path}`, entry);
  }
  assertNoPathCollisions(output.keys());
  return output;
}

function collectUserSiteHistoricalPairs(tree, currentNames) {
  const feed = new Map();
  for (const [path, entry] of tree) {
    if (!path.startsWith("tasty-desktop/")) continue;
    const relativePath = path.slice("tasty-desktop/".length);
    if (!relativePath || relativePath.includes("/")) throw new Error(`Unsupported legacy feed path: ${path}`);
    if (currentNames.includes(relativePath) || relativePath === ".nojekyll") continue;
    if (!historicalAssetKind(relativePath)) throw new Error(`Unexpected legacy feed file: ${path}`);
    feed.set(relativePath, entry);
  }
  return collectHistoricalPairs(feed, []);
}

function collectHistoricalPairs(files, currentNames) {
  const pairs = new Map();
  for (const [path, entry] of files) {
    if (currentNames.includes(path) || !historicalAssetKind(path)) continue;
    pairs.set(path, entry);
  }
  for (const path of pairs.keys()) {
    const counterpart = path.endsWith(".sig") ? path.slice(0, -4) : `${path}.sig`;
    if (!pairs.has(counterpart)) throw new Error(`Historical updater asset has no complete pair: ${path}`);
  }
  return pairs;
}

function historicalAssetKind(path) {
  const installer = path.endsWith(".sig") ? path.slice(0, -4) : path;
  return HISTORICAL_INSTALLER.test(installer);
}

function addEntry(target, path, entry) {
  const normalized = { path, mode: entry.mode, bytes: entry.bytes, sourceObject: entry.object };
  const existing = target.get(path);
  if (existing && (existing.mode !== normalized.mode || !existing.bytes.equals(normalized.bytes))) {
    throw new Error(`Conflicting migration source bytes for ${path}`);
  }
  target.set(path, existing ?? normalized);
}

async function validateSignatureEvidence(path, expectedHash, feed, publicKey) {
  const bytes = await readBoundedFile(path, 64 * 1024, "signature verification evidence");
  const evidenceHash = sha256Bytes(bytes);
  if (evidenceHash !== expectedHash) throw new Error("Signature verification evidence SHA-256 does not match the separately witnessed prerequisite");
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Signature verification evidence is invalid: ${message(error)}`);
  }
  assertExactKeys(evidence, [
    "schemaVersion", "verified", "verifier", "verifiedAt", "installerSha256", "signatureFileSha256",
    "decodedSignatureSha256", "updaterPublicKeySha256",
  ], "signature verification evidence");
  if (evidence.schemaVersion !== 1 || evidence.verified !== true) throw new Error("Signature verification evidence must record schema 1 and verified=true");
  if (typeof evidence.verifier !== "string" || !evidence.verifier.trim() || evidence.verifier.length > 512 || /[\r\n]/u.test(evidence.verifier)) {
    throw new Error("Signature verification evidence must name one local verifier");
  }
  const verifiedAt = normalizeDate(evidence.verifiedAt, "signature verification time");
  const signatureFile = requiredEntry(feed.files, feed.signatureName, feed.label).bytes;
  const decodedSignature = Buffer.from(feed.signatureText, "base64");
  const expected = {
    installerSha256: feed.installerHash,
    signatureFileSha256: sha256Bytes(signatureFile),
    decodedSignatureSha256: sha256Bytes(decodedSignature),
    updaterPublicKeySha256: sha256Bytes(publicKey.bytes),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (evidence[key] !== value) throw new Error(`Signature verification evidence does not match ${key}`);
  }
  return { ...evidence, verifier: evidence.verifier.trim(), verifiedAt, evidenceSha256: evidenceHash };
}

async function runUpdaterSignatureVerifier(options, feed, publicKey) {
  await assertRegularFile(options.cargoExecutable, "Cargo executable");
  const manifestPath = join(dirname(options.tauriConfig), "Cargo.toml");
  const lockfilePath = join(dirname(options.tauriConfig), "Cargo.lock");
  await assertRegularFile(manifestPath, "Cargo manifest");
  await assertRegularFile(lockfilePath, "Cargo lockfile");
  const installerPath = join(options.releaseDirectory, feed.installerName);
  await assertRegularFile(installerPath, "Release installer");
  const temporary = await mkdtemp(join(tmpdir(), "kimi-feed-signature-"));
  const signaturePath = join(temporary, "installer.minisig");
  const publicKeyPath = join(temporary, "updater.pub");
  try {
    await writeFile(signaturePath, decodeCanonicalBase64(feed.signatureText, "detached updater signature"), { flag: "wx" });
    await writeFile(publicKeyPath, publicKey.bytes, { flag: "wx" });
    const args = [
      "run", "--offline", "--locked", "--manifest-path", manifestPath,
      "--example", "verify_updater_signature", "--", installerPath, signaturePath, publicKeyPath,
    ];
    try {
      await execFileAsync(options.cargoExecutable, args, {
        cwd: dirname(options.tauriConfig),
        encoding: "utf8",
        env: { ...process.env, CARGO_NET_OFFLINE: "true", GIT_TERMINAL_PROMPT: "0" },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Offline updater signature verification failed: ${message(error?.stderr || error?.stdout || error)}`);
    }
    return {
      verifier: "cargo run --offline --locked --example verify_updater_signature",
      cargoExecutable: basename(options.cargoExecutable),
      cargoNetOffline: true,
      manifestSha256: await sha256File(manifestPath),
      lockfileSha256: await sha256File(lockfilePath),
      exitCode: 0,
    };
  } finally {
    await removeTree(temporary);
  }
}

async function readUpdaterPublicKey(path) {
  const configBytes = await readBoundedFile(path, 2 * 1024 * 1024, "Tauri configuration");
  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Tauri configuration is invalid: ${message(error)}`);
  }
  const encoded = config?.plugins?.updater?.pubkey;
  if (typeof encoded !== "string") throw new Error("Tauri updater public key is missing");
  const bytes = decodeCanonicalBase64(encoded, "Tauri updater public key");
  return { bytes, configSha256: sha256Bytes(configBytes) };
}

async function createRootRepository(output, branch, files, identity, messageText) {
  await runGit(["init", "--quiet", `--initial-branch=${branch}`, "."], output);
  for (const [path, entry] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(output, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: "wx" });
    const object = (await runGit(["hash-object", "-w", "--no-filters", "--", path], output)).stdout.trim();
    if (entry.sourceObject && object !== entry.sourceObject) throw new Error(`Raw Git blob changed while preparing ${path}`);
    await runGit(["update-index", "--add", "--cacheinfo", entry.mode, object, path], output);
  }
  const tree = (await runGit(["write-tree"], output)).stdout.trim();
  const environment = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: identity.date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: identity.date,
  };
  const commit = (await runGit(["commit-tree", tree, "-m", messageText], output, output, "utf8", environment)).stdout.trim();
  await runGit(["update-ref", `refs/heads/${branch}`, commit], output);
  await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], output);
}

async function createCanonicalRepairRepository(output, sourceRepository, oldCommit, oldFiles, nextFiles, identity) {
  const branch = "gh-pages";
  await runGit(["init", "--quiet", `--initial-branch=${branch}`, "."], output);
  for (const [path, entry] of [...oldFiles].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(output, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: "wx" });
    const object = (await runGit(["hash-object", "-w", "--no-filters", "--", path], output)).stdout.trim();
    if (object !== entry.object) throw new Error(`Could not reproduce the observed gh-pages blob for ${path}`);
    await runGit(["update-index", "--add", "--cacheinfo", entry.mode, object, path], output);
  }
  const oldTree = (await runGit(["write-tree"], output)).stdout.trim();
  const observedTree = (await runGit(["rev-parse", `${oldCommit}^{tree}`], sourceRepository)).stdout.trim();
  if (oldTree !== observedTree) throw new Error(`Could not reproduce observed gh-pages tree ${observedTree}`);
  const rawCommit = (await runGit(["cat-file", "commit", oldCommit], sourceRepository, sourceRepository, null)).stdout;
  const commitFile = join(output, ".git", "observed-gh-pages.commit");
  await writeFile(commitFile, rawCommit, { flag: "wx" });
  try {
    const reproducedCommit = (await runGit(["hash-object", "-w", "-t", "commit", "--", commitFile], output)).stdout.trim();
    if (reproducedCommit !== oldCommit) throw new Error(`Could not reproduce observed gh-pages commit ${oldCommit}`);
  } finally {
    await rm(commitFile, { force: true });
  }
  await runGit(["update-ref", `refs/heads/${branch}`, oldCommit], output);
  await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], output);

  const oldPaths = new Set(oldFiles.keys());
  for (const path of oldPaths) {
    if (!nextFiles.has(path)) throw new Error(`Canonical repair may not delete the observed gh-pages file ${path}`);
  }
  for (const [path, entry] of [...nextFiles].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(output, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
    const object = (await runGit(["hash-object", "-w", "--no-filters", "--", path], output)).stdout.trim();
    if (entry.sourceObject && object !== entry.sourceObject) throw new Error(`Raw Git blob changed while repairing ${path}`);
    await runGit(["update-index", "--add", "--cacheinfo", entry.mode, object, path], output);
  }
  const tree = (await runGit(["write-tree"], output)).stdout.trim();
  if (tree === oldTree) throw new Error("Canonical repair did not change the drifted gh-pages tree");
  const environment = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: identity.date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: identity.date,
  };
  const commit = (await runGit([
    "commit-tree", tree, "-p", oldCommit, "-m", "Repair Kimi Code updater feed",
  ], output, output, "utf8", environment)).stdout.trim();
  await runGit(["update-ref", `refs/heads/${branch}`, commit, oldCommit], output);
}

async function computeEvidence(options, sources, canonicalFiles, userSiteFiles) {
  const [canonical, userSite] = await Promise.all([
    inspectOutputRepository(options.canonicalOutput, "gh-pages", canonicalFiles, options.identity, "Repair Kimi Code updater feed", {
      expectedParent: options.productGhPagesSha,
      expectedCommitCount: 2,
    }),
    inspectOutputRepository(options.userSiteOutput, "main", userSiteFiles, options.identity, "Seed Kimi Code compatibility feed", {
      expectedParent: null,
      expectedCommitCount: 1,
    }),
  ]);
  const cname = [...sources.userSiteTree].find(([path]) => !path.includes("/") && path.toLocaleLowerCase("en-US") === "cname");
  const releaseFiles = await manifestFiles(sources.release.files);
  const pagesFiles = await manifestFiles(new Map(sources.pages.currentNames.map((name) => [name, sources.productTree.get(name)])));
  const unrelated = await manifestFiles(new Map([...sources.userSiteTree].filter(([path]) => {
    return !path.startsWith("tasty-desktop/") && path !== "tasty-desktop" && path.toLocaleLowerCase("en-US") !== "cname";
  })));
  return {
    schemaVersion: 1,
    identity: options.identity,
    cname: {
      decision: "omit",
      sourcePresent: Boolean(cname),
      sourceMode: cname?.[1].mode ?? null,
      sourceSha256: cname ? sha256Bytes(cname[1].bytes) : null,
      sourceValue: cname ? cname[1].bytes.toString("utf8") : null,
      outputPresent: false,
    },
    backups: {
      product: bundleEvidence(sources.product),
      userSite: bundleEvidence(sources.userSite),
    },
    release: {
      version: sources.release.manifest.version,
      manifestUrl: sources.release.manifest.platforms["windows-x86_64"].url,
      releaseFiles,
      canonicalPagesFiles: pagesFiles,
      semanticManifestMatch: true,
      semanticChecksumMatch: true,
      installerBytesMatch: true,
      signatureBytesMatch: true,
      manifestByteDrift: !requiredEntry(sources.release.files, "latest.json", sources.release.label).bytes.equals(
        requiredEntry(sources.productTree, "latest.json", sources.pages.label).bytes,
      ),
      checksumByteDrift: !requiredEntry(sources.release.files, "SHA256SUMS.txt", sources.release.label).bytes.equals(
        requiredEntry(sources.productTree, "SHA256SUMS.txt", sources.pages.label).bytes,
      ),
      bootstrapAuthority: "github-release",
      legacyRemoteCapture: "unavailable",
      signatureEvidence: sources.signatureEvidence,
      cryptographicVerification: sources.cryptographicVerification,
      updaterPublicKeySha256: sha256Bytes(sources.publicKey.bytes),
      tauriConfigSha256: sources.publicKey.configSha256,
    },
    userSiteSource: {
      observedCommit: options.userSiteMainSha,
      preservedUnrelatedFiles: unrelated,
    },
    outputs: { canonical, userSite },
  };
}

function bundleEvidence(bundle) {
  return {
    file: basename(bundle.path),
    size: bundle.size,
    sha256: bundle.hash,
    requiredRef: bundle.requiredRef,
    observedObject: bundle.observedObject,
    heads: bundle.heads,
  };
}

async function inspectOutputRepository(directory, branch, expectedFiles, identity, expectedMessage, history) {
  const config = await readFile(join(directory, ".git", "config"), "utf8");
  if (/^\s*\[remote\s+/imu.test(config)) throw new Error(`Prepared ${branch} repository contains a remote`);
  const headBranch = (await runGit(["symbolic-ref", "--short", "HEAD"], directory)).stdout.trim();
  if (headBranch !== branch) throw new Error(`Prepared repository HEAD is ${headBranch}, not ${branch}`);
  const commit = (await runGit(["rev-parse", "HEAD"], directory)).stdout.trim();
  const tree = (await runGit(["rev-parse", "HEAD^{tree}"], directory)).stdout.trim();
  const count = (await runGit(["rev-list", "--count", "HEAD"], directory)).stdout.trim();
  const parents = (await runGit(["rev-list", "--parents", "-n", "1", "HEAD"], directory)).stdout.trim().split(/\s+/u);
  const expectedParents = history.expectedParent ? [commit, history.expectedParent] : [commit];
  if (count !== String(history.expectedCommitCount) || !isDeepStrictEqual(parents, expectedParents)) {
    throw new Error(`Prepared ${branch} repository has an unexpected commit ancestry`);
  }
  const refs = (await runGit(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags", "refs/remotes"], directory)).stdout
    .split(/\r?\n/u).filter(Boolean);
  if (refs.length !== 1 || refs[0] !== `refs/heads/${branch}\0${commit}`) throw new Error(`Prepared ${branch} repository has unexpected refs`);
  const metadata = (await runGit(["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s", "HEAD"], directory)).stdout.trim().split("\0");
  const normalizedMetadata = [metadata[0], metadata[1], normalizeDate(metadata[2], "author date"), metadata[3], metadata[4], normalizeDate(metadata[5], "committer date"), metadata[6]];
  if (!isDeepStrictEqual(normalizedMetadata, [identity.name, identity.email, identity.date, identity.name, identity.email, identity.date, expectedMessage])) {
    throw new Error(`Prepared ${branch} commit metadata is not deterministic`);
  }
  const status = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], directory)).stdout.trim();
  if (status) throw new Error(`Prepared ${branch} repository is not clean`);
  const fsck = await runGit(["fsck", "--full", "--no-reflogs", "--unreachable"], directory);
  if (/\b(?:dangling|unreachable)\b/iu.test(`${fsck.stdout}\n${fsck.stderr}`)) throw new Error(`Prepared ${branch} repository contains unreachable objects`);
  const actual = await readGitTree(directory, commit);
  assertFileMapsEqual(expectedFiles, actual, `prepared ${branch} tree`);
  return {
    branch,
    commit,
    tree,
    parent: history.expectedParent,
    expectedFastForward: Boolean(history.expectedParent),
    files: await manifestFiles(actual),
  };
}

function assertFileMapsEqual(expected, actual, label) {
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (!isDeepStrictEqual(expectedPaths, actualPaths)) throw new Error(`${label} paths differ from the approved source`);
  for (const path of expectedPaths) {
    const left = expected.get(path);
    const right = actual.get(path);
    if (left.mode !== right.mode || !left.bytes.equals(right.bytes)) throw new Error(`${label} changed ${path}`);
    if (left.sourceObject && left.sourceObject !== right.object) throw new Error(`${label} changed the raw blob for ${path}`);
  }
}

async function manifestFiles(files) {
  return [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, entry]) => ({
    path,
    mode: entry.mode,
    size: entry.bytes.length,
    sha256: sha256Bytes(entry.bytes),
    gitObject: entry.object ?? gitBlobId(entry.bytes),
  }));
}

function normalizeOptions(input) {
  const required = [
    "releaseDirectory", "productBundle", "productBundleSha256", "productGhPagesSha", "userSiteBundle",
    "userSiteBundleSha256", "userSiteMainSha", "signatureEvidence", "signatureEvidenceSha256", "cargoExecutable", "tauriConfig", "canonicalOutput",
    "userSiteOutput", "evidenceOutput", "cnameDecision", "identityName", "identityEmail", "commitDate",
  ];
  for (const key of required) if (typeof input?.[key] !== "string" || !input[key]) throw new Error(`${key} is required`);
  if (input.cnameDecision !== "omit") throw new Error("cnameDecision must be explicitly set to omit");
  if (!NOREPLY.test(input.identityEmail)) throw new Error("identityEmail must be an approved GitHub noreply address");
  if (/^[\s]|[\r\n<>]|[\s]$/u.test(input.identityName) || input.identityName.length > 128) throw new Error("identityName is invalid");
  const identity = { name: input.identityName, email: input.identityEmail, date: normalizeDate(input.commitDate, "commit date") };
  const options = {
    releaseDirectory: resolve(input.releaseDirectory),
    productBundle: resolve(input.productBundle),
    productBundleSha256: normalizeHash(input.productBundleSha256, "product bundle SHA-256"),
    productGhPagesSha: normalizeObject(input.productGhPagesSha, "product gh-pages SHA"),
    userSiteBundle: resolve(input.userSiteBundle),
    userSiteBundleSha256: normalizeHash(input.userSiteBundleSha256, "user-site bundle SHA-256"),
    userSiteMainSha: normalizeObject(input.userSiteMainSha, "user-site main SHA"),
    signatureEvidence: resolve(input.signatureEvidence),
    signatureEvidenceSha256: normalizeHash(input.signatureEvidenceSha256, "signature evidence SHA-256"),
    cargoExecutable: resolve(input.cargoExecutable),
    tauriConfig: resolve(input.tauriConfig),
    canonicalOutput: resolve(input.canonicalOutput),
    userSiteOutput: resolve(input.userSiteOutput),
    evidenceOutput: resolve(input.evidenceOutput),
    cnameDecision: input.cnameDecision,
    identity,
  };
  const distinct = [options.canonicalOutput, options.userSiteOutput, options.evidenceOutput];
  if (new Set(distinct.map((path) => path.toLocaleLowerCase("en-US"))).size !== distinct.length) throw new Error("Migration outputs must be distinct");
  for (let left = 0; left < distinct.length; left += 1) {
    for (let right = left + 1; right < distinct.length; right += 1) {
      if (isNestedPath(distinct[left], distinct[right]) || isNestedPath(distinct[right], distinct[left])) {
        throw new Error("Migration outputs must not be ancestors or descendants of one another");
      }
    }
  }
  for (const path of Object.values(options).filter((value) => typeof value === "string")) assertLocalPath(path);
  return options;
}

function assertLocalPath(path) {
  if (/^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/u.test(path)) throw new Error(`Network and device paths are not allowed: ${path}`);
}

function isNestedPath(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function assertFreshOutput(path) {
  try {
    await lstat(path);
    throw new Error(`Output must not already exist: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function claimOutputDirectory(path) {
  await mkdir(dirname(path), { recursive: true });
  await mkdir(path);
}

async function assertFreshFile(path) {
  return assertFreshOutput(path);
}

function assertTreeSafe(tree, label) {
  assertNoPathCollisions(tree.keys());
  for (const path of tree.keys()) validateRepositoryPath(path, label);
}

function validateRepositoryPath(path, label = "repository path") {
  const parts = path.replaceAll("\\", "/").split("/");
  if (!path || path.includes("\\") || path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".." || part.toLocaleLowerCase("en-US") === ".git")) {
    throw new Error(`Invalid ${label}: ${path}`);
  }
}

function assertNoPathCollisions(paths) {
  const seen = new Map();
  for (const path of paths) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(key);
    if (previous && previous !== path) throw new Error(`Case or Unicode-equivalent path collision: ${previous} and ${path}`);
    seen.set(key, path);
  }
}

function requiredEntry(files, name, label) {
  const entry = files.get(name);
  if (!entry) throw new Error(`${label} is missing ${name}`);
  return entry;
}

function parseChecksum(bytes, label) {
  const text = bytes.toString("ascii");
  const match = /^([0-9a-f]{64})  ([^\r\n]+)(?:\r\n|\n)$/u.exec(text);
  if (!match) throw new Error(`${label} SHA256SUMS.txt must contain one canonical entry`);
  return { hash: match[1], name: match[2] };
}

function canonicalBase64Text(bytes, label) {
  const text = bytes.toString("ascii");
  const match = /^([A-Za-z0-9+/]+={0,2})(?:\r\n|\n)?$/u.exec(text);
  if (!match) throw new Error(`${label} must be canonical base64 with at most one final newline`);
  decodeCanonicalBase64(match[1], label);
  return match[1];
}

function decodeCanonicalBase64(text, label) {
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) throw new Error(`${label} is not canonical base64`);
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.toString("base64") !== text) throw new Error(`${label} is not canonical base64`);
  return bytes;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

function normalizeHash(value, label) {
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${label} must be one lowercase 64-character hash`);
  return normalized;
}

function normalizeObject(value, label) {
  const normalized = value.toLowerCase();
  if (!OBJECT_ID.test(normalized)) throw new Error(`${label} must be one full SHA-1 object ID`);
  return normalized;
}

function normalizeDate(value, label) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.valueOf())) throw new Error(`${label} is invalid`);
  return date.toISOString();
}

async function assertRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular local file: ${path}`);
}

async function readBoundedFile(path, maximum, label) {
  await assertRegularFile(path, label);
  const info = await stat(path);
  if (info.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return readFile(path);
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

function removeTree(path) {
  return rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function splitNul(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error("Git output is missing its final NUL");
  return records;
}

async function runGit(args, cwd, safeDirectory = cwd, encoding = "utf8", extraEnvironment = {}) {
  const command = args[0];
  if (!ALLOWED_GIT_COMMANDS.has(command)) throw new Error(`Disallowed Git command: ${command}`);
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extraEnvironment,
  };
  try {
    const result = await execFileAsync("git", [
      "-c", `safe.directory=${resolve(safeDirectory)}`,
      "-c", "commit.gpgSign=false",
      ...args,
    ], { cwd, encoding, env: environment, windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
    return { stdout: result.stdout ?? (encoding === null ? Buffer.alloc(0) : ""), stderr: result.stderr ?? (encoding === null ? Buffer.alloc(0) : "") };
  } catch (error) {
    throw new Error(`Local Git ${command} failed: ${message(error?.stderr || error?.stdout || error)}`);
  }
}

function message(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return value instanceof Error ? value.message : String(value).trim();
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    const property = key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, property)) throw new Error(`Duplicate argument: ${key}`);
    options[property] = value;
  }
  return options;
}

async function runCli() {
  const [command, ...values] = process.argv.slice(2);
  const options = parseArguments(values);
  const result = command === "prepare"
    ? await prepareFeedMigration(options)
    : command === "verify"
      ? await verifyFeedMigration(options)
      : (() => { throw new Error(`Unknown migration command: ${command ?? "<empty>"}`); })();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
