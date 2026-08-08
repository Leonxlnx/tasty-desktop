import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertFeedAdvance,
  authorizeRelease,
  canonicalRepository,
  compareReleaseVersions,
  createReleaseManifest,
  legacyRepository,
  prepareReleaseFeed,
  publishFeedBranch,
  releaseFileNames,
  releaseIdentity,
  verifyPublishedFeeds,
  verifyReleaseFeedDirectory,
} from "./release-feed.mjs";

const execFileAsync = promisify(execFile);
const signature = Buffer.from("untrusted comment: deterministic test signature\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n", "utf8").toString("base64");
const pubDate = "2026-08-08T12:34:56.000Z";

test("accepts only canonical stable release identities", () => {
  assert.deepEqual(releaseIdentity("v1.2.3"), { tag: "v1.2.3", version: "1.2.3", parts: [1n, 2n, 3n] });
  for (const invalid of ["1.2.3", "v01.2.3", "v1.2", "v1.2.3-beta.1", "v1.2.3+build", "v1.2.3 "]) {
    assert.throws(() => releaseIdentity(invalid), /canonical stable SemVer/);
  }
  assert.equal(compareReleaseVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareReleaseVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareReleaseVersions("1.2.3", "2.0.0"), -1);
});

test("builds one deterministic canonical Kimi release manifest", () => {
  const manifest = createReleaseManifest({ version: "1.2.3", tag: "v1.2.3", repository: canonicalRepository, pubDate: "2026-08-08T14:34:56+02:00", signature });
  assert.deepEqual(manifest, {
    version: "1.2.3",
    notes: "Kimi Code 1.2.3",
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature,
        url: "https://github.com/Leonxlnx/kimi-code-desktop/releases/download/v1.2.3/Kimi-Code-1.2.3-x64-setup.exe",
      },
    },
  });
  assert.throws(() => createReleaseManifest({ version: "1.2.4", tag: "v1.2.3", repository: canonicalRepository, pubDate, signature }), /does not match/);
  assert.throws(() => createReleaseManifest({ version: "1.2.3", tag: "v1.2.3", repository: legacyRepository, pubDate, signature }), /must be exactly/);
});

test("prepares and verifies exactly four deterministic release assets", async () => {
  await withTemporaryDirectory(async (root) => {
    const feed = await createFeed(root, "1.2.3", "installer-one");
    assert.deepEqual((await readdir(feed)).sort(), [...releaseFileNames("1.2.3")].sort());
    await verifyReleaseFeedDirectory(feed, feedOptions("1.2.3"));

    const firstManifest = await readFile(join(feed, "latest.json"));
    const secondRoot = join(root, "second");
    const second = await createFeed(secondRoot, "1.2.3", "installer-one");
    assert.ok(firstManifest.equals(await readFile(join(second, "latest.json"))));

    await writeFile(join(feed, "unexpected.txt"), "nope");
    await assert.rejects(verifyReleaseFeedDirectory(feed, feedOptions("1.2.3")), /must contain exactly/);
  });
});

test("rejects malformed, mismatched, and non-deterministic feed contents", async () => {
  await withTemporaryDirectory(async (root) => {
    const feed = await createFeed(root, "1.2.3", "installer-one");
    const checksum = join(feed, "SHA256SUMS.txt");
    await writeFile(checksum, `${(await readFile(checksum, "utf8")).trim()}\r\n`, "ascii");
    await assert.rejects(verifyReleaseFeedDirectory(feed, feedOptions("1.2.3")), /does not exactly match/);

    const repaired = await createFeed(join(root, "repaired"), "1.2.3", "installer-one");
    const manifestPath = join(repaired, "latest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.platforms["windows-x86_64"].url = "https://example.test/installer.exe";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(verifyReleaseFeedDirectory(repaired, feedOptions("1.2.3")), /Manifest URL must be/);
  });
});

test("allows forward publication and rejects rollback or equal-version drift", async () => {
  await withTemporaryDirectory(async (root) => {
    const current = await createFeed(join(root, "current"), "1.1.0", "current");
    const next = await createFeed(join(root, "next"), "1.2.0", "next");
    assert.equal((await assertFeedAdvance(current, next, feedOptions("1.2.0"))).state, "advance");
    assert.equal((await assertFeedAdvance(next, next, feedOptions("1.2.0"))).state, "identical");

    const rollback = await createFeed(join(root, "rollback"), "1.0.9", "old");
    await assert.rejects(assertFeedAdvance(current, rollback, feedOptions("1.0.9")), /rollback/);
    const drift = await createFeed(join(root, "drift"), "1.1.0", "different bytes");
    await assert.rejects(assertFeedAdvance(current, drift, feedOptions("1.1.0")), /drift/);
    const future = await createFeed(join(root, "future"), "1.3.0", "future bytes");
    await writeFile(join(current, releaseFileNames("1.3.0")[0]), "hostile pre-existing bytes");
    await assert.rejects(assertFeedAdvance(current, future, feedOptions("1.3.0")), /candidate asset drift/);
  });
});

test("authorizes only one annotated tag that points exactly to remote main", async () => {
  await withTemporaryDirectory(async (root) => {
    const remote = join(root, "source.git");
    const source = join(root, "source");
    await runGit(["init", "--bare", remote], root);
    await runGit(["clone", remote, source], root);
    await configureGit(source);
    await runGit(["switch", "-c", "main"], source);
    await writeFile(join(source, "README.md"), "release\n");
    await runGit(["add", "--", "README.md"], source);
    await runGit(["commit", "-m", "Release source"], source);
    await runGit(["tag", "-a", "v1.2.3", "-m", "v1.2.3"], source);
    await runGit(["push", "origin", "main", "refs/tags/v1.2.3"], source);
    const authorized = await authorizeRelease({ repository: canonicalRepository, mode: "dual", legacyFeedRepository: legacyRepository, tag: "v1.2.3", repositoryDirectory: source });
    assert.equal(authorized.version, "1.2.3");
    assert.match(authorized.sha, /^[0-9a-f]{40}$/);
    assert.match(authorized.tagObject, /^[0-9a-f]{40}$/);
    await authorizeRelease({
      repository: canonicalRepository,
      mode: "dual",
      legacyFeedRepository: legacyRepository,
      tag: "v1.2.3",
      repositoryDirectory: source,
      expectedSha: authorized.sha,
      expectedTagObject: authorized.tagObject,
    });
    await assert.rejects(authorizeRelease({
      repository: canonicalRepository,
      mode: "dual",
      legacyFeedRepository: legacyRepository,
      tag: "v1.2.3",
      repositoryDirectory: source,
      expectedSha: "0".repeat(40),
      expectedTagObject: authorized.tagObject,
    }), /changed after initial authorization/);
    await assert.rejects(authorizeRelease({
      repository: canonicalRepository,
      mode: "dual",
      legacyFeedRepository: legacyRepository,
      tag: "v1.2.3",
      repositoryDirectory: source,
      expectedSha: authorized.sha,
      expectedTagObject: "0".repeat(40),
    }), /tag object changed after initial authorization/);

    await runGit(["switch", "-c", "not-main"], source);
    await writeFile(join(source, "README.md"), "off main\n");
    await runGit(["commit", "-am", "Off main"], source);
    await runGit(["tag", "-a", "v1.2.4", "-m", "v1.2.4"], source);
    await runGit(["push", "origin", "refs/tags/v1.2.4"], source);
    await assert.rejects(authorizeRelease({ repository: canonicalRepository, mode: "dual", legacyFeedRepository: legacyRepository, tag: "v1.2.4", repositoryDirectory: source }), /must point exactly/);

    await runGit(["switch", "main"], source);
    await runGit(["tag", "v1.2.5"], source);
    await runGit(["push", "origin", "refs/tags/v1.2.5"], source);
    await assert.rejects(authorizeRelease({ repository: canonicalRepository, mode: "dual", legacyFeedRepository: legacyRepository, tag: "v1.2.5", repositoryDirectory: source }), /annotated tag/);
    await assert.rejects(authorizeRelease({ repository: canonicalRepository, mode: "single", legacyFeedRepository: legacyRepository, tag: "v1.2.3", repositoryDirectory: source }), /must be exactly dual/);
  });
});

test("publishes by fast-forward, resumes identically, and rejects a remote race", async () => {
  await withTemporaryDirectory(async (root) => {
    const remote = join(root, "feed.git");
    const seed = join(root, "seed");
    const worker = join(root, "worker");
    await runGit(["init", "--bare", remote], root);
    await runGit(["clone", remote, seed], root);
    await configureGit(seed);
    await runGit(["switch", "--orphan", "gh-pages"], seed);
    const initial = await createFeed(join(root, "initial"), "1.0.0", "initial");
    await copyFeed(initial, seed, "1.0.0");
    await writeFile(join(seed, ".nojekyll"), "");
    await runGit(["add", "--", ".nojekyll", ...releaseFileNames("1.0.0")], seed);
    await runGit(["commit", "-m", "Seed feed"], seed);
    await runGit(["push", "origin", "HEAD:refs/heads/gh-pages"], seed);

    await runGit(["clone", "--branch", "gh-pages", remote, worker], root);
    await configureGit(worker);
    const next = await createFeed(join(root, "next"), "1.1.0", "next");
    const published = await publishFeedBranch({ repositoryDirectory: worker, sourceDirectory: next, version: "1.1.0", tag: "v1.1.0", repository: canonicalRepository, pubDate });
    assert.equal(published.changed, true);
    const resumed = await publishFeedBranch({ repositoryDirectory: worker, sourceDirectory: next, version: "1.1.0", tag: "v1.1.0", repository: canonicalRepository, pubDate });
    assert.equal(resumed.changed, false);

    const raceFeed = await createFeed(join(root, "race-feed"), "1.2.0", "race release");
    await assert.rejects(publishFeedBranch({
      repositoryDirectory: worker,
      sourceDirectory: raceFeed,
      version: "1.2.0",
      tag: "v1.2.0",
      repository: canonicalRepository,
      pubDate,
      beforePush: async () => {
        const racer = join(root, "racer");
        await runGit(["clone", "--branch", "gh-pages", remote, racer], root);
        await configureGit(racer);
        await writeFile(join(racer, "concurrent.txt"), "concurrent\n");
        await runGit(["add", "--", "concurrent.txt"], racer);
        await runGit(["commit", "-m", "Concurrent feed update"], racer);
        await runGit(["push", "origin", "HEAD:refs/heads/gh-pages"], racer);
      },
    }), /race detected/);
  });
});

test("legacy publication preserves every file outside tasty-desktop current assets", async () => {
  await withTemporaryDirectory(async (root) => {
    const remote = join(root, "site.git");
    const seed = join(root, "site-seed");
    const worker = join(root, "site-worker");
    await runGit(["init", "--bare", remote], root);
    await runGit(["clone", remote, seed], root);
    await configureGit(seed);
    await runGit(["switch", "-c", "main"], seed);
    await writeFile(join(seed, "index.html"), "desired site\n");
    await writeFile(join(seed, "CNAME"), "example.invalid\n");
    await writeFile(join(seed, ".nojekyll"), "root sentinel\n");
    const initial = await createFeed(join(root, "legacy-initial"), "1.0.0", "initial");
    await mkdir(join(seed, "tasty-desktop"));
    await copyFeed(initial, join(seed, "tasty-desktop"), "1.0.0");
    await writeFile(join(seed, "tasty-desktop", "Kimi-Code-0.9.0-x64-setup.exe"), "historical\n");
    await runGit(["add", "--", "index.html", "CNAME", ".nojekyll", "tasty-desktop"], seed);
    await runGit(["commit", "-m", "Seed user site"], seed);
    await runGit(["push", "origin", "main"], seed);
    await runGit(["clone", "--branch", "main", remote, worker], root);
    await configureGit(worker);
    const next = await createFeed(join(root, "legacy-next"), "1.1.0", "next");
    const before = new Map(await Promise.all(["index.html", "CNAME", ".nojekyll", "tasty-desktop/Kimi-Code-0.9.0-x64-setup.exe"].map(async (path) => [path, await readFile(join(worker, path))])));
    const result = await publishFeedBranch({ repositoryDirectory: worker, sourceDirectory: next, branch: "main", feedPath: "tasty-desktop", version: "1.1.0", tag: "v1.1.0", repository: canonicalRepository, pubDate });
    assert.equal(result.changed, true);
    for (const [path, bytes] of before) assert.ok(bytes.equals(await readFile(join(worker, path))), `${path} changed`);
  });
});

test("rejects Git attributes that transform a committed feed asset", async () => {
  await withTemporaryDirectory(async (root) => {
    const remote = join(root, "filtered-feed.git");
    const seed = join(root, "filtered-seed");
    const worker = join(root, "filtered-worker");
    await runGit(["init", "--bare", remote], root);
    await runGit(["clone", remote, seed], root);
    await configureGit(seed);
    await runGit(["switch", "--orphan", "gh-pages"], seed);
    const initial = await createFeed(join(root, "filtered-initial"), "1.0.0", "initial");
    await copyFeed(initial, seed, "1.0.0");
    await writeFile(join(seed, ".gitattributes"), "*.exe text\n");
    await runGit(["add", "--", ".gitattributes", ...releaseFileNames("1.0.0")], seed);
    await runGit(["commit", "-m", "Seed filtered feed"], seed);
    await runGit(["push", "origin", "HEAD:refs/heads/gh-pages"], seed);

    await runGit(["clone", "--branch", "gh-pages", remote, worker], root);
    await configureGit(worker);
    const next = await createFeed(join(root, "filtered-next"), "1.1.0", "line one\r\nline two\r\n");
    await assert.rejects(publishFeedBranch({
      repositoryDirectory: worker,
      sourceDirectory: next,
      version: "1.1.0",
      tag: "v1.1.0",
      repository: canonicalRepository,
      pubDate,
    }), /attributes or filters changed/);
  });
});

test("verifies both published endpoints byte-for-byte with bounded retry", async () => {
  await withTemporaryDirectory(async (root) => {
    const feed = await createFeed(root, "1.2.3", "installer-one");
    const files = new Map(await Promise.all(releaseFileNames("1.2.3").map(async (name) => [name, await readFile(join(feed, name))])));
    let firstLatest = true;
    let sleeps = 0;
    const seenNonces = new Set();
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      seenNonces.add(parsed.searchParams.get("nonce"));
      const name = parsed.pathname.split("/").at(-1);
      if (firstLatest && parsed.hostname === "leonxlnx.github.io" && parsed.pathname.startsWith("/kimi-code-desktop/") && name === "latest.json") {
        firstLatest = false;
        return new Response("stale", { status: 200 });
      }
      const bytes = files.get(name);
      return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
    };
    const result = await verifyPublishedFeeds({
      endpoints: [
        "https://leonxlnx.github.io/kimi-code-desktop/latest.json",
        "https://leonxlnx.github.io/tasty-desktop/latest.json",
      ],
      expectedDirectory: feed,
      ...feedOptions("1.2.3"),
      retries: 2,
      delayMs: 0,
      fetchImpl,
      sleep: async () => { sleeps += 1; },
    });
    assert.equal(result.version, "1.2.3");
    assert.equal(sleeps, 1);
    const second = await verifyPublishedFeeds({
      endpoints: [
        "https://leonxlnx.github.io/kimi-code-desktop/latest.json",
        "https://leonxlnx.github.io/tasty-desktop/latest.json",
      ],
      expectedDirectory: feed,
      ...feedOptions("1.2.3"),
      retries: 1,
      delayMs: 0,
      fetchImpl,
      sleep: async () => {},
    });
    assert.notEqual(result.nonce, second.nonce);
    assert.deepEqual(seenNonces, new Set([result.nonce, second.nonce]));
  });
});

test("rejects redirects instead of treating the canonical endpoint as the legacy feed", async () => {
  await withTemporaryDirectory(async (root) => {
    const feed = await createFeed(root, "1.2.3", "installer-one");
    const files = new Map(await Promise.all(releaseFileNames("1.2.3").map(async (name) => [name, await readFile(join(feed, name))])));
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/tasty-desktop/")) {
        return { ok: true, status: 200, redirected: true, url: "https://leonxlnx.github.io/kimi-code-desktop/latest.json", headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const bytes = files.get(parsed.pathname.split("/").at(-1));
      return new Response(bytes, { status: 200 });
    };
    await assert.rejects(verifyPublishedFeeds({
      endpoints: ["https://leonxlnx.github.io/kimi-code-desktop/latest.json", "https://leonxlnx.github.io/tasty-desktop/latest.json"],
      expectedDirectory: feed,
      ...feedOptions("1.2.3"),
      retries: 1,
      delayMs: 0,
      fetchImpl,
      sleep: async () => {},
    }), /Redirects are not allowed/);
  });
});

test("release workflow keeps authorization, secrets, publication, and token scope fail-closed", async () => {
  const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:\s*\r?\n\s+inputs:\s*\r?\n\s+tag:/);
  assert.doesNotMatch(workflow, /push:\s*\r?\n\s+tags:/);
  assert.doesNotMatch(workflow, /--tag\s+"\$\{\{\s*inputs\.tag\s*\}\}"/);
  assert.match(workflow, /RELEASE_TAG:\s*\$\{\{\s*inputs\.tag\s*\}\}/);
  assert.match(workflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(workflow, /group:\s*windows-release-\$\{\{\s*github\.repository\s*\}\}/);
  assert.match(workflow, /tag_object:\s*\$\{\{\s*steps\.release\.outputs\.tag_object\s*\}\}/);
  assert.equal(workflow.match(/release-feed\.mjs authorize/g)?.length, 7);
  assert.equal(workflow.match(/--expected-sha\s+"\$\{\{\s*needs\.authorize\.outputs\.sha\s*\}\}"/g)?.length, 6);
  assert.equal(workflow.match(/--expected-tag-object\s+"\$\{\{\s*needs\.authorize\.outputs\.tag_object\s*\}\}"/g)?.length, 6);
  assert.match(workflow, /Reuse an existing immutable four-asset release[\s\S]*gh release download[\s\S]*verify-directory[\s\S]*Existing updater signature verification failed/);
  assert.equal(workflow.match(/if:\s*steps\.authoritative\.outputs\.release_exists != 'true'/g)?.length, 4);
  assert.ok(workflow.indexOf("Reuse an existing immutable four-asset release") < workflow.indexOf("Preflight both feeds before any release mutation"));
  assert.match(workflow, /--nonce\s+"\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}"/);
  assert.match(workflow, /UPDATER_FEED_MODE/);
  assert.match(workflow, /Leonxlnx\/kimi-code-desktop/);
  assert.match(workflow, /Leonxlnx\/Leonxlnx\.github\.io/);
  assert.match(workflow, /--feed-path tasty-desktop/);
  assert.doesNotMatch(workflow, /repository:\s*Leonxlnx\/tasty-desktop/);
  assert.match(workflow, /environment:\s*release-signing/);
  assert.match(workflow, /environment:\s*legacy-update-feed/);
  assert.match(workflow, /actions\/create-github-app-token@67018539274d69449ef7c02e8e71183d1719ab42/);
  assert.doesNotMatch(workflow, /\bPAT\b|--force|force-with-lease/i);
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/);
  assert.match(workflow, /GIT_CONFIG_COUNT/);
  assert.match(workflow, /actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/);
  assert.match(workflow, /publish-release:\s*\r?\n\s+needs:\s*\[authorize, build, preflight-feeds\]/);
  assert.match(workflow, /repositories:\s*Leonxlnx\.github\.io/);
  assert.doesNotMatch(workflow, /git add --all|git add -A/);
  assert.match(workflow, /needs:\s*authorize/);
  assert.match(workflow, /node scripts\/release-feed\.mjs verify-published/);
});

function feedOptions(version) {
  return { version, tag: `v${version}`, repository: canonicalRepository, pubDate, exact: true };
}

async function createFeed(root, version, installerContents) {
  await mkdir(root, { recursive: true });
  const installer = join(root, "input.exe");
  const signaturePath = join(root, "input.exe.sig");
  await writeFile(installer, installerContents);
  await writeFile(signaturePath, `${signature}\n`, "ascii");
  const feed = join(root, "feed");
  await prepareReleaseFeed({ directory: feed, installerPath: installer, signaturePath, version, tag: `v${version}`, repository: canonicalRepository, pubDate });
  return feed;
}

async function copyFeed(source, target, version) {
  for (const name of releaseFileNames(version)) await copyFile(join(source, name), join(target, name));
}

async function configureGit(directory) {
  await runGit(["config", "user.name", "Release Feed Test"], directory);
  await runGit(["config", "user.email", "release-feed-test@users.noreply.github.com"], directory);
}

async function runGit(args, cwd) {
  try {
    return await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${(error?.stderr || error?.stdout || error?.message || "unknown error").trim()}`);
  }
}

async function withTemporaryDirectory(callback) {
  const root = await mkdtemp(join(tmpdir(), "kimi-release-feed-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
