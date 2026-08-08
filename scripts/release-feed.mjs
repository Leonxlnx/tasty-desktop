import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const canonicalRepository = "Leonxlnx/kimi-code-desktop";
export const legacyRepository = "Leonxlnx/Leonxlnx.github.io";
export const legacyFeedPath = "tasty-desktop";
export const updaterPlatform = "windows-x86_64";

export function releaseIdentity(tagInput) {
  const tag = String(tagInput ?? "");
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`Release tag must be a canonical stable SemVer tag: ${tag || "<empty>"}`);
  return { tag, version: match.slice(1).join("."), parts: match.slice(1).map(BigInt) };
}

export function compareReleaseVersions(leftInput, rightInput) {
  const left = releaseIdentity(String(leftInput).startsWith("v") ? leftInput : `v${leftInput}`).parts;
  const right = releaseIdentity(String(rightInput).startsWith("v") ? rightInput : `v${rightInput}`).parts;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function normalizePublicationDate(input) {
  const value = String(input ?? "").trim();
  const date = new Date(value);
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`Invalid release commit timestamp: ${value || "<empty>"}`);
  return date.toISOString();
}

export function releaseFileNames(versionInput) {
  const { version } = releaseIdentity(`v${String(versionInput).replace(/^v/, "")}`);
  const installer = `Kimi-Code-${version}-x64-setup.exe`;
  return [installer, `${installer}.sig`, "latest.json", "SHA256SUMS.txt"];
}

export function createReleaseManifest({ version: versionInput, tag: tagInput, repository, pubDate, signature }) {
  const { tag, version } = releaseIdentity(tagInput);
  if (version !== String(versionInput)) throw new Error(`Tag ${tag} does not match version ${versionInput}`);
  assertCanonicalRepository(repository);
  const normalizedSignature = normalizeSignature(signature);
  const installer = releaseFileNames(version)[0];
  return {
    version,
    notes: `Kimi Code ${version}`,
    pub_date: normalizePublicationDate(pubDate),
    platforms: {
      [updaterPlatform]: {
        signature: normalizedSignature,
        url: `https://github.com/${canonicalRepository}/releases/download/${tag}/${installer}`,
      },
    },
  };
}

export async function prepareReleaseFeed({ directory, installerPath, signaturePath, version, tag, repository, pubDate }) {
  const outputDirectory = resolve(directory);
  await mkdir(outputDirectory, { recursive: true });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0) throw new Error(`Release feed staging directory must be empty: ${outputDirectory}`);

  const signature = normalizeSignature(await readFile(resolve(signaturePath), "utf8"));
  const names = releaseFileNames(version);
  const installerName = names[0];
  const stagedInstaller = join(outputDirectory, installerName);
  await copyFile(resolve(installerPath), stagedInstaller);
  await writeFile(join(outputDirectory, `${installerName}.sig`), `${signature}\n`, "ascii");

  const manifest = createReleaseManifest({ version, tag, repository, pubDate, signature });
  await writeFile(join(outputDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const installerHash = await sha256File(stagedInstaller);
  await writeFile(join(outputDirectory, "SHA256SUMS.txt"), `${installerHash}  ${installerName}\n`, "ascii");

  return verifyReleaseFeedDirectory(outputDirectory, { version, tag, repository, pubDate, exact: true });
}

export async function verifyReleaseFeedDirectory(directory, { version, tag, repository, pubDate, exact = true }) {
  assertCanonicalRepository(repository);
  const root = resolve(directory);
  const names = releaseFileNames(version);
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isFile())) throw new Error(`Release feed staging contains a non-file entry: ${root}`);
  if (exact && !sameStrings(files, [...names].sort())) {
    throw new Error(`Release feed must contain exactly: ${names.join(", ")}; found: ${files.join(", ")}`);
  }
  for (const name of names) await assertRegularFile(join(root, name));

  const manifestBytes = await readFile(join(root, "latest.json"));
  const manifestText = manifestBytes.toString("utf8");
  if (!manifestText.endsWith("\n") || manifestText.startsWith("\uFEFF")) {
    throw new Error("latest.json must be UTF-8 without a BOM and end in one LF");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`latest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertExactKeys(manifest, ["version", "notes", "pub_date", "platforms"], "latest.json");
  if (manifest.version !== version) throw new Error(`Manifest version ${manifest.version} does not match ${version}`);
  if (manifest.notes !== `Kimi Code ${version}`) throw new Error(`Manifest notes do not match Kimi Code ${version}`);
  if (manifest.pub_date !== normalizePublicationDate(pubDate)) throw new Error("Manifest pub_date is not the tagged commit timestamp");
  assertExactKeys(manifest.platforms, [updaterPlatform], "manifest platforms");
  const platform = manifest.platforms[updaterPlatform];
  assertExactKeys(platform, ["signature", "url"], `manifest platform ${updaterPlatform}`);

  const installerName = names[0];
  const expectedUrl = `https://github.com/${canonicalRepository}/releases/download/${tag}/${installerName}`;
  if (platform.url !== expectedUrl) throw new Error(`Manifest URL must be ${expectedUrl}`);
  const signature = normalizeSignature(await readFile(join(root, `${installerName}.sig`), "utf8"));
  if (platform.signature !== signature) throw new Error("Manifest signature does not match the staged signature file");
  const signatureBytes = await readFile(join(root, `${installerName}.sig`));
  if (!signatureBytes.equals(Buffer.from(`${signature}\n`, "ascii"))) throw new Error("Signature file is not canonical ASCII with one LF");

  const installerHash = await sha256File(join(root, installerName));
  const expectedChecksums = `${installerHash}  ${installerName}\n`;
  const checksums = await readFile(join(root, "SHA256SUMS.txt"));
  if (!checksums.equals(Buffer.from(expectedChecksums, "ascii"))) throw new Error("SHA256SUMS.txt does not exactly match the installer");

  const expectedManifest = `${JSON.stringify(createReleaseManifest({ version, tag, repository, pubDate, signature }), null, 2)}\n`;
  if (manifestText !== expectedManifest) throw new Error("latest.json is not in the deterministic canonical format");
  return { version, tag, installerName, installerHash, signature, names, manifest, manifestBytes };
}

export async function assertFeedAdvance(currentDirectory, nextDirectory, options) {
  const next = await verifyReleaseFeedDirectory(nextDirectory, { ...options, exact: true });
  const currentManifestPath = join(resolve(currentDirectory), "latest.json");
  await assertRegularFile(currentManifestPath);
  let current;
  try {
    current = JSON.parse(await readFile(currentManifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Published latest.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof current?.version !== "string") throw new Error("Published latest.json has no version");
  const comparison = compareReleaseVersions(next.version, current.version);
  if (comparison < 0) throw new Error(`Refusing update-feed rollback from ${current.version} to ${next.version}`);
  if (comparison === 0) {
    for (const name of next.names) {
      const [published, staged] = await Promise.all([
        readFile(join(resolve(currentDirectory), name)),
        readFile(join(resolve(nextDirectory), name)),
      ]);
      if (!published.equals(staged)) throw new Error(`Equal-version update-feed drift detected: ${name}`);
    }
    return { state: "identical", currentVersion: current.version, next };
  }
  for (const name of next.names.slice(0, 2)) {
    const publishedPath = join(resolve(currentDirectory), name);
    try {
      const [published, staged] = await Promise.all([readFile(publishedPath), readFile(join(resolve(nextDirectory), name))]);
      if (!published.equals(staged)) throw new Error(`Pre-existing candidate asset drift detected: ${name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { state: "advance", currentVersion: current.version, next };
}

export async function publishFeedBranch({ repositoryDirectory, sourceDirectory, branch = "gh-pages", feedPath = "", remote = "origin", expectedRemoteRepository, version, tag, repository, pubDate, beforePush }) {
  const normalizedFeedPath = normalizeFeedPath(feedPath);
  const isCurrentFeed = expectedRemoteRepository === canonicalRepository && branch === "gh-pages" && normalizedFeedPath === "";
  const isLegacyFeed = expectedRemoteRepository === legacyRepository && branch === "main" && normalizedFeedPath === legacyFeedPath;
  if (expectedRemoteRepository && !isCurrentFeed && !isLegacyFeed) {
    throw new Error(`Unsupported feed target: ${expectedRemoteRepository}:${branch}:${normalizedFeedPath || "/"}`);
  }
  const target = resolve(repositoryDirectory);
  const source = resolve(sourceDirectory);
  const targetFeed = normalizedFeedPath ? join(target, ...normalizedFeedPath.split("/")) : target;
  const statusBefore = await git(["status", "--porcelain"], target);
  if (statusBefore.stdout.trim()) throw new Error(`Feed checkout is not clean before publication:\n${statusBefore.stdout.trim()}`);
  if (expectedRemoteRepository) await assertRemoteRepository(target, remote, expectedRemoteRepository);

  const baseline = await remoteBranchHead(target, remote, branch);
  const localHead = (await git(["rev-parse", "HEAD"], target)).stdout.trim();
  if (localHead !== baseline) throw new Error(`Feed checkout is stale: local ${localHead}, remote ${baseline}`);
  const unrelatedBefore = normalizedFeedPath ? await unrelatedTree(target, normalizedFeedPath, localHead) : undefined;
  const advance = await assertFeedAdvance(targetFeed, source, { version, tag, repository, pubDate });
  if (advance.state === "identical") {
    const identicalHead = await remoteBranchHead(target, remote, branch);
    if (identicalHead !== baseline) throw new Error(`Update-feed race detected: remote moved from ${baseline} to ${identicalHead}`);
    return { changed: false, commit: localHead, version };
  }

  await mkdir(targetFeed, { recursive: true });
  for (const name of advance.next.names) await copyFile(join(source, name), join(targetFeed, name));
  const stagedPaths = advance.next.names.map((name) => normalizedFeedPath ? `${normalizedFeedPath}/${name}` : name);
  if (isCurrentFeed || (!expectedRemoteRepository && branch === "gh-pages" && normalizedFeedPath === "")) {
    await writeFile(join(target, ".nojekyll"), "", "ascii");
    stagedPaths.unshift(".nojekyll");
  }
  await git(["add", "--", ...stagedPaths], target);
  const staged = await gitResult(["diff", "--cached", "--quiet"], target, [0, 1]);
  if (staged.code === 0) throw new Error("Feed advance produced no staged change");
  await git(["commit", "-m", `Publish ${tag} update feed`], target);
  const commit = (await git(["rev-parse", "HEAD"], target)).stdout.trim();
  for (const name of advance.next.names) {
    const sourceObject = (await git(["hash-object", "--no-filters", join(source, name)], target)).stdout.trim();
    const committedPath = normalizedFeedPath ? `${normalizedFeedPath}/${name}` : name;
    const committedObject = (await git(["rev-parse", `${commit}:${committedPath}`], target)).stdout.trim();
    if (committedObject !== sourceObject) {
      throw new Error(`Git attributes or filters changed the committed update-feed bytes: ${committedPath}`);
    }
  }
  if (unrelatedBefore) {
    const unrelatedAfter = await unrelatedTree(target, normalizedFeedPath, commit);
    if (!sameStrings(unrelatedBefore, unrelatedAfter)) throw new Error(`Feed publication changed files outside ${normalizedFeedPath}/`);
  }

  if (beforePush) await beforePush({ baseline, commit, target });
  const beforePushHead = await remoteBranchHead(target, remote, branch);
  if (beforePushHead !== baseline) throw new Error(`Update-feed race detected: remote moved from ${baseline} to ${beforePushHead}`);
  await git(["push", remote, `HEAD:refs/heads/${branch}`], target);
  const publishedHead = await remoteBranchHead(target, remote, branch);
  if (publishedHead !== commit) throw new Error(`Update-feed push verification failed: expected ${commit}, found ${publishedHead}`);
  const statusAfter = await git(["status", "--porcelain"], target);
  if (statusAfter.stdout.trim()) throw new Error(`Feed checkout is not clean after publication:\n${statusAfter.stdout.trim()}`);
  return { changed: true, commit, version };
}

export async function authorizeRelease({ repository, mode, legacyFeedRepository, tag, repositoryDirectory = ".", remote = "origin", defaultBranch = "main", expectedSha, expectedTagObject }) {
  assertCanonicalRepository(repository);
  if (mode !== "dual") throw new Error(`UPDATER_FEED_MODE must be exactly dual for publication: ${mode || "<empty>"}`);
  if (legacyFeedRepository !== legacyRepository) {
    throw new Error(`LEGACY_FEED_REPOSITORY must be exactly ${legacyRepository}: ${legacyFeedRepository || "<empty>"}`);
  }
  if (defaultBranch !== "main") throw new Error(`Canonical release branch must be exactly main: ${defaultBranch || "<empty>"}`);
  const identity = releaseIdentity(tag);
  const cwd = resolve(repositoryDirectory);
  const remoteRefs = await git(["ls-remote", remote, `refs/tags/${identity.tag}`, `refs/tags/${identity.tag}^{}`], cwd);
  const refs = new Map(remoteRefs.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, ref, ...extra] = line.trim().split(/\s+/);
    if (!sha || !ref || extra.length) throw new Error(`Unexpected ls-remote output: ${line}`);
    return [ref, sha];
  }));
  const tagRef = `refs/tags/${identity.tag}`;
  const peeledRef = `${tagRef}^{}`;
  const tagObject = refs.get(tagRef);
  const remoteCommit = refs.get(peeledRef);
  if (!tagObject || !remoteCommit || tagObject === remoteCommit || refs.size !== 2) {
    throw new Error(`Release tag ${identity.tag} must exist remotely as one annotated tag`);
  }

  const candidateRef = `refs/release-candidates/${identity.tag}`;
  await git(["fetch", "--no-tags", remote, `+refs/heads/${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`, `+${tagRef}:${candidateRef}`], cwd);
  const objectType = (await git(["cat-file", "-t", candidateRef], cwd)).stdout.trim();
  if (objectType !== "tag") throw new Error(`Release tag ${identity.tag} is not annotated`);
  const fetchedTagObject = (await git(["rev-parse", candidateRef], cwd)).stdout.trim();
  const fetchedCommit = (await git(["rev-parse", `${candidateRef}^{}`], cwd)).stdout.trim();
  const mainCommit = (await git(["rev-parse", `refs/remotes/${remote}/${defaultBranch}`], cwd)).stdout.trim();
  if (fetchedTagObject !== tagObject || fetchedCommit !== remoteCommit) throw new Error(`Release tag ${identity.tag} moved during authorization`);
  if (fetchedCommit !== mainCommit) throw new Error(`Release tag ${identity.tag} must point exactly to origin/${defaultBranch} (${mainCommit})`);
  if (expectedSha !== undefined && fetchedCommit !== normalizeObjectId(expectedSha, "expected release commit")) {
    throw new Error(`Release commit changed after initial authorization: expected ${expectedSha}, found ${fetchedCommit}`);
  }
  if (expectedTagObject !== undefined && fetchedTagObject !== normalizeObjectId(expectedTagObject, "expected annotated tag object")) {
    throw new Error(`Annotated tag object changed after initial authorization: expected ${expectedTagObject}, found ${fetchedTagObject}`);
  }
  const commitTimestamp = (await git(["show", "-s", "--format=%cI", fetchedCommit], cwd)).stdout.trim();
  return { ...identity, sha: fetchedCommit, tagObject, pubDate: normalizePublicationDate(commitTimestamp) };
}

export async function verifyPublishedFeeds({ endpoints, expectedDirectory, version, tag, repository, pubDate, nonce = randomUUID(), retries = 20, delayMs = 15_000, fetchImpl = globalThis.fetch, sleep = defaultSleep }) {
  const requiredEndpoints = [
    "https://leonxlnx.github.io/kimi-code-desktop/latest.json",
    "https://leonxlnx.github.io/tasty-desktop/latest.json",
  ];
  if (!Array.isArray(endpoints) || !sameStrings([...endpoints].sort(), [...requiredEndpoints].sort())) throw new Error("Both exact canonical and legacy updater endpoints are required");
  const verificationNonce = normalizeVerificationNonce(nonce);
  const expected = await verifyReleaseFeedDirectory(expectedDirectory, { version, tag, repository, pubDate, exact: true });
  const expectedFiles = new Map(await Promise.all(expected.names.map(async (name) => [name, await readFile(join(resolve(expectedDirectory), name))])));
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || basename(url.pathname) !== "latest.json") throw new Error(`Invalid updater endpoint: ${endpoint}`);
    await retry(async (attempt) => {
      for (const [name, bytes] of expectedFiles) {
        const assetUrl = new URL(name === "latest.json" ? url.href : new URL(name, url).href);
        assetUrl.searchParams.set("release", tag);
        assetUrl.searchParams.set("nonce", verificationNonce);
        assetUrl.searchParams.set("attempt", String(attempt));
        const published = await fetchBytes(fetchImpl, assetUrl, bytes.length);
        if (!published.equals(bytes)) throw new Error(`${assetUrl.origin}${assetUrl.pathname} does not match the staged ${name}`);
      }
    }, { retries, delayMs, sleep, label: endpoint });
  }
  return { version, endpoints: [...endpoints], installerHash: expected.installerHash, nonce: verificationNonce };
}

async function fetchBytes(fetchImpl, url, expectedLength) {
  const response = await fetchImpl(url, { headers: { "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"} for ${url}`);
  if (response.redirected) throw new Error(`Redirects are not allowed for updater assets: ${url}`);
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== url.origin || finalUrl.pathname !== url.pathname) throw new Error(`Updater asset resolved to a different URL: ${response.url}`);
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && Number(contentLength) > expectedLength) {
    throw new Error(`Updater asset Content-Length exceeds its expected size for ${url}: ${contentLength}`);
  }
  if (!response.body?.getReader) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > expectedLength) throw new Error(`Updater asset exceeds its expected size: ${url}`);
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > expectedLength) {
      await reader.cancel();
      throw new Error(`Updater asset exceeds its expected size: ${url}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

async function retry(operation, { retries, delayMs, sleep, label }) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw new Error(`Published feed verification failed for ${label} after ${retries} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function defaultSleep(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function assertCanonicalRepository(repository) {
  if (repository !== canonicalRepository) throw new Error(`Release repository must be exactly ${canonicalRepository}: ${repository || "<empty>"}`);
}

function normalizeFeedPath(input) {
  const value = String(input ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (value && (!/^[A-Za-z0-9._/-]+$/.test(value) || value.split("/").some((part) => part === "." || part === ".." || !part))) {
    throw new Error(`Invalid feed path: ${input}`);
  }
  return value;
}

function normalizeObjectId(input, label) {
  const value = String(input ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be one full SHA-1 object ID`);
  return value;
}

function normalizeVerificationNonce(input) {
  const value = String(input ?? "");
  if (!value || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Publication verification nonce must be 1-128 URL-safe characters");
  }
  return value;
}

function normalizeSignature(input) {
  const signature = String(input ?? "").trim();
  if (!signature || signature.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error("Updater signature must be canonical base64");
  }
  const decoded = Buffer.from(signature, "base64");
  if (!decoded.length || decoded.toString("base64") !== signature) throw new Error("Updater signature is not canonical base64");
  return signature;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !sameStrings(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertRegularFile(path) {
  try {
    if (!(await stat(path)).isFile()) throw new Error();
  } catch {
    throw new Error(`Required release feed file is missing: ${path}`);
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertRemoteRepository(directory, remote, expectedRepository) {
  const remoteUrl = (await git(["remote", "get-url", remote], directory)).stdout.trim();
  const escaped = expectedRepository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^(?:https://github\\.com/|git@github\\.com:)${escaped}(?:\\.git)?$`, "i").test(remoteUrl)) {
    throw new Error(`Feed remote must be ${expectedRepository}: ${remoteUrl}`);
  }
}

async function remoteBranchHead(directory, remote, branch) {
  const result = await git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], directory);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Remote ${remote} must already contain exactly one refs/heads/${branch}`);
  const [sha, ref, ...extra] = lines[0].trim().split(/\s+/);
  if (!sha || ref !== `refs/heads/${branch}` || extra.length) throw new Error(`Unexpected remote branch output: ${lines[0]}`);
  return sha;
}

async function unrelatedTree(directory, feedPath, commit) {
  const prefix = `${feedPath}/`;
  const tree = (await git(["ls-tree", "-r", "--full-tree", commit], directory)).stdout.split(/\r?\n/).filter(Boolean);
  return tree.filter((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error(`Unexpected git tree entry: ${line}`);
    return !line.slice(separator + 1).replace(/\\/g, "/").startsWith(prefix);
  });
}

async function git(args, cwd) {
  const result = await gitResult(args, cwd, [0]);
  return result;
}

async function gitResult(args, cwd, acceptedCodes) {
  try {
    const { stdout = "", stderr = "" } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : 1;
    if (acceptedCodes.includes(code)) return { code, stdout: error?.stdout ?? "", stderr: error?.stderr ?? "" };
    throw new Error(`git ${args.join(" ")} failed (${code}): ${(error?.stderr || error?.stdout || error?.message || "unknown error").trim()}`);
  }
}

function parseArguments(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2);
    const existing = options.get(name);
    options.set(name, existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value]);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
}

async function runCli() {
  const [command, ...values] = process.argv.slice(2);
  const options = parseArguments(values);
  let result;
  if (command === "authorize") {
    result = await authorizeRelease({
      repository: required(options, "repository"),
      mode: required(options, "mode"),
      legacyFeedRepository: required(options, "legacy-repository"),
      tag: required(options, "tag"),
      repositoryDirectory: options.get("repository-directory") ?? ".",
      remote: options.get("remote") ?? "origin",
      defaultBranch: options.get("default-branch") ?? "main",
      expectedSha: options.get("expected-sha"),
      expectedTagObject: options.get("expected-tag-object"),
    });
    const output = options.get("github-output");
    if (typeof output === "string") {
      await writeFile(output, `tag=${result.tag}\nversion=${result.version}\nsha=${result.sha}\ntag_object=${result.tagObject}\npub_date=${result.pubDate}\n`, { encoding: "utf8", flag: "a" });
    }
  } else if (command === "prepare") {
    result = await prepareReleaseFeed({
      directory: required(options, "directory"), installerPath: required(options, "installer"), signaturePath: required(options, "signature"),
      version: required(options, "version"), tag: required(options, "tag"), repository: required(options, "repository"), pubDate: required(options, "pub-date"),
    });
  } else if (command === "verify-directory") {
    result = await verifyReleaseFeedDirectory(required(options, "directory"), {
      version: required(options, "version"), tag: required(options, "tag"), repository: required(options, "repository"), pubDate: required(options, "pub-date"), exact: true,
    });
  } else if (command === "publish") {
    result = await publishFeedBranch({
      repositoryDirectory: required(options, "repository-directory"), sourceDirectory: required(options, "source-directory"),
      expectedRemoteRepository: required(options, "expected-remote-repository"), version: required(options, "version"), tag: required(options, "tag"),
      repository: required(options, "repository"), pubDate: required(options, "pub-date"), branch: options.get("branch") ?? "gh-pages", feedPath: options.get("feed-path") ?? "", remote: options.get("remote") ?? "origin",
    });
  } else if (command === "check-advance") {
    result = await assertFeedAdvance(required(options, "current-directory"), required(options, "next-directory"), {
      version: required(options, "version"), tag: required(options, "tag"), repository: required(options, "repository"), pubDate: required(options, "pub-date"),
    });
  } else if (command === "verify-published") {
    const endpoint = options.get("endpoint");
    const endpoints = Array.isArray(endpoint) ? endpoint : typeof endpoint === "string" ? [endpoint] : [];
    result = await verifyPublishedFeeds({
      endpoints, expectedDirectory: required(options, "directory"), version: required(options, "version"), tag: required(options, "tag"),
      repository: required(options, "repository"), pubDate: required(options, "pub-date"),
      nonce: options.get("nonce"),
      retries: options.has("retries") ? Number(required(options, "retries")) : undefined,
      delayMs: options.has("delay-ms") ? Number(required(options, "delay-ms")) : undefined,
    });
  } else {
    throw new Error(`Unknown release-feed command: ${command || "<empty>"}`);
  }
  console.log(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
