import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareFeedMigration, verifyFeedMigration } from "./prepare-feed-migration.mjs";

const execFileAsync = promisify(execFile);
const identity = {
  name: "Leon Lin",
  email: "219127460+Leonxlnx@users.noreply.github.com",
  date: "2026-08-08T18:00:00.000Z",
};

test("prepares deterministic fast-forward and parentless preseeds from raw bundle objects", async () => {
  await withFixture(async (fixture) => {
    const first = await prepareFeedMigration(fixture.options);
    assert.equal(first.version, "0.8.3");
    assert.match(first.canonicalCommit, /^[0-9a-f]{40}$/u);
    assert.match(first.userSiteCommit, /^[0-9a-f]{40}$/u);

    const canonicalParents = (await git(["rev-list", "--parents", "-n", "1", "HEAD"], fixture.options.canonicalOutput)).stdout.trim().split(" ");
    assert.deepEqual(canonicalParents, [first.canonicalCommit, fixture.productCommit]);
    assert.equal((await git(["rev-list", "--count", "HEAD"], fixture.options.canonicalOutput)).stdout.trim(), "2");
    assert.equal((await git(["rev-list", "--count", "HEAD"], fixture.options.userSiteOutput)).stdout.trim(), "1");
    assert.equal((await git(["rev-list", "--parents", "-n", "1", "HEAD"], fixture.options.userSiteOutput)).stdout.trim().split(" ").length, 1);
    assert.equal((await git(["for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"], fixture.options.canonicalOutput)).stdout.trim(), "");
    assert.equal((await git(["for-each-ref", "--format=%(refname)", "refs/remotes", "refs/tags"], fixture.options.userSiteOutput)).stdout.trim(), "");

    assert.deepEqual(await readFile(join(fixture.options.canonicalOutput, "latest.json")), fixture.releaseLatest);
    assert.deepEqual(await readFile(join(fixture.options.canonicalOutput, "SHA256SUMS.txt")), fixture.releaseChecksums);
    assert.deepEqual(await readFile(join(fixture.options.userSiteOutput, "tasty-desktop", "latest.json")), fixture.releaseLatest);
    assert.deepEqual(await readFile(join(fixture.options.userSiteOutput, "tasty-desktop", "SHA256SUMS.txt")), fixture.releaseChecksums);
    await assert.rejects(readFile(join(fixture.options.userSiteOutput, "CNAME")), { code: "ENOENT" });
    assert.deepEqual(await readFile(join(fixture.options.userSiteOutput, "README.md")), Buffer.from("Personal site\n"));
    assert.deepEqual(await readFile(join(fixture.options.userSiteOutput, "bin", "keep.sh")), Buffer.from("#!/bin/sh\necho keep\n"));
    assert.equal((await git(["ls-tree", "HEAD", "bin/keep.sh"], fixture.options.userSiteOutput)).stdout.split(" ")[0], "100755");
    assert.deepEqual(await readFile(join(fixture.options.canonicalOutput, fixture.historicalInstaller)), Buffer.from("historical-installer"));
    assert.deepEqual(await readFile(join(fixture.options.userSiteOutput, "tasty-desktop", fixture.historicalInstaller)), Buffer.from("historical-installer"));

    const committedLatest = (await git(["rev-parse", "HEAD:latest.json"], fixture.options.canonicalOutput)).stdout.trim();
    const rawReleaseLatest = (await git(["hash-object", "--no-filters", "--", join(fixture.releaseDirectory, "latest.json")], fixture.options.canonicalOutput)).stdout.trim();
    assert.equal(committedLatest, rawReleaseLatest);

    const evidence = JSON.parse(await readFile(fixture.options.evidenceOutput, "utf8"));
    assert.equal(evidence.release.bootstrapAuthority, "github-release");
    assert.equal(evidence.release.manifestByteDrift, true);
    assert.equal(evidence.release.checksumByteDrift, true);
    assert.equal(evidence.outputs.canonical.parent, fixture.productCommit);
    assert.equal(evidence.outputs.canonical.expectedFastForward, true);
    assert.equal(evidence.outputs.userSite.parent, null);
    assert.deepEqual(evidence.cname, {
      decision: "omit",
      sourcePresent: true,
      sourceMode: "100644",
      sourceSha256: sha256(Buffer.from("leonlin.me\n")),
      sourceValue: "leonlin.me\n",
      outputPresent: false,
    });
    assert.equal(evidence.backups.product.sha256, fixture.options.productBundleSha256);
    assert.equal(evidence.backups.userSite.sha256, fixture.options.userSiteBundleSha256);
    await verifyFeedMigration(fixture.options);

    const secondOptions = {
      ...fixture.options,
      canonicalOutput: join(fixture.root, "canonical-second"),
      userSiteOutput: join(fixture.root, "user-site-second"),
      evidenceOutput: join(fixture.root, "evidence-second.json"),
    };
    const second = await prepareFeedMigration(secondOptions);
    assert.equal(second.canonicalCommit, first.canonicalCommit);
    assert.equal(second.userSiteCommit, first.userSiteCommit);
    assert.deepEqual(await readFile(secondOptions.evidenceOutput), await readFile(fixture.options.evidenceOutput));

    const verifierRuns = (await readFile(fixture.cargoLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(verifierRuns.length, 5);
    for (const run of verifierRuns) {
      assert.deepEqual(run.args.slice(0, 7), [
        "--offline", "--locked", "--manifest-path", join(fixture.root, "Cargo.toml"),
        "--example", "verify_updater_signature", "--",
      ]);
      assert.equal(run.args[7], join(fixture.releaseDirectory, fixture.installerName));
      assert.equal(run.args.length, 10);
      assert.equal(run.cargoNetOffline, "true");
      assert.equal(run.signatureBase64, fixture.signature);
      assert.equal(run.publicKeyBase64, fixture.publicKey.toString("base64"));
    }
  });
});

test("fails closed on invalid authority, evidence, outputs, and CNAME decisions", async (context) => {
  await context.test("wrong bundle hash", async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(prepareFeedMigration({ ...fixture.options, productBundleSha256: "0".repeat(64) }), /bundle hash mismatch/iu);
    });
  });

  await context.test("Release and Pages semantic drift", async () => {
    await withFixture(async (fixture) => {
      const manifest = JSON.parse(fixture.releaseLatest.toString("utf8"));
      manifest.notes = "Unexpected";
      await writeFile(join(fixture.releaseDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\r\n`.replace(/(?<!\r)\n/gu, "\r\n"));
      await assert.rejects(prepareFeedMigration(fixture.options), /unexpected release notes|manifests are not semantically identical/iu);
    });
  });

  await context.test("bad signature evidence", async () => {
    await withFixture(async (fixture) => {
      const evidence = JSON.parse(await readFile(fixture.options.signatureEvidence, "utf8"));
      evidence.installerSha256 = "f".repeat(64);
      await writeFile(fixture.options.signatureEvidence, `${JSON.stringify(evidence, null, 2)}\n`);
      await assert.rejects(prepareFeedMigration(fixture.options), /evidence SHA-256 does not match/iu);
    });
  });

  await context.test("non-fresh output", async () => {
    await withFixture(async (fixture) => {
      await mkdir(fixture.options.canonicalOutput);
      await writeFile(join(fixture.options.canonicalOutput, "keep.txt"), "do not overwrite\n");
      await assert.rejects(prepareFeedMigration(fixture.options), /must not already exist/iu);
      assert.equal(await readFile(join(fixture.options.canonicalOutput, "keep.txt"), "utf8"), "do not overwrite\n");
    });
  });

  await context.test("non-omit CNAME choice", async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(prepareFeedMigration({ ...fixture.options, cnameDecision: "preserve" }), /explicitly set to omit/iu);
    });
  });

  await context.test("nested outputs", async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(prepareFeedMigration({
        ...fixture.options,
        userSiteOutput: join(fixture.options.canonicalOutput, "nested"),
      }), /must not be ancestors or descendants/iu);
    });
  });

  await context.test("cryptographic verifier failure", async () => {
    await withFixture(async (fixture) => {
      await writeFile(fixture.cargoScript, "process.stderr.write('invalid signature'); process.exit(17);\n");
      await assert.rejects(prepareFeedMigration(fixture.options), /offline updater signature verification failed.*invalid signature/iu);
    });
  });
});

test("verify detects output and evidence tampering and helper contains no network mutation path", async () => {
  const source = await readFile(resolve("scripts/prepare-feed-migration.mjs"), "utf8");
  assert.doesNotMatch(source, /from "node:(?:dns|http|https|net|tls)"/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /runGit\(\["(?:clone|fetch|pull|push|ls-remote|remote)"/u);
  assert.deepEqual(
    [...source.matchAll(/execFileAsync\(([^,\r\n]+)/gu)].map((match) => match[1]).sort(),
    ["\"git\"", "options.cargoExecutable"].sort(),
  );
  assert.match(source, /"run", "--offline", "--locked", "--manifest-path"/u);
  assert.match(source, /CARGO_NET_OFFLINE: "true"/u);

  await withFixture(async (fixture) => {
    await prepareFeedMigration(fixture.options);
    const originalReadme = await readFile(join(fixture.options.userSiteOutput, "README.md"));
    await writeFile(join(fixture.options.userSiteOutput, "README.md"), "tampered\n");
    await assert.rejects(verifyFeedMigration(fixture.options), /not clean|changed README/iu);
    await writeFile(join(fixture.options.userSiteOutput, "README.md"), originalReadme);
    const evidence = JSON.parse(await readFile(fixture.options.evidenceOutput, "utf8"));
    evidence.release.bootstrapAuthority = "untrusted";
    await writeFile(fixture.options.evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`);
    await assert.rejects(verifyFeedMigration(fixture.options), /does not match the recomputed local state/iu);
  });
});

async function createFixture(root) {
  const releaseDirectory = join(root, "release");
  await mkdir(releaseDirectory);
  const installerName = "Kimi-Code-Desktop-0.8.3-x64-setup.exe";
  const signatureName = `${installerName}.sig`;
  const installer = Buffer.from("MZ deterministic installer bytes");
  const decodedSignature = Buffer.from("deterministic updater signature");
  const signature = decodedSignature.toString("base64");
  const signatureFile = Buffer.from(signature, "ascii");
  const installerHash = sha256(installer);
  const manifest = {
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://leonxlnx.github.io/kimi-code-desktop/${installerName}`,
      },
    },
    notes: "Kimi Code Desktop 0.8.3",
    version: "0.8.3",
    pub_date: "2026-07-19T01:52:02.2861780Z",
  };
  const prettyManifest = JSON.stringify(manifest, null, 2);
  const releaseLatest = Buffer.from(`${prettyManifest.replace(/\n/gu, "\r\n")}\r\n`);
  const pagesLatest = Buffer.from(`${prettyManifest}\n`);
  const releaseChecksums = Buffer.from(`${installerHash}  ${installerName}\r\n`, "ascii");
  const pagesChecksums = Buffer.from(`${installerHash}  ${installerName}\n`, "ascii");
  await writeFile(join(releaseDirectory, installerName), installer);
  await writeFile(join(releaseDirectory, signatureName), signatureFile);
  await writeFile(join(releaseDirectory, "latest.json"), releaseLatest);
  await writeFile(join(releaseDirectory, "SHA256SUMS.txt"), releaseChecksums);

  const historicalInstaller = "Kimi-Code-Desktop-0.7.0-x64-setup.exe";
  const productRepository = join(root, "product-source");
  const productFiles = new Map([
    [".nojekyll", { mode: "100644", bytes: Buffer.alloc(0) }],
    [installerName, { mode: "100644", bytes: installer }],
    [signatureName, { mode: "100644", bytes: signatureFile }],
    ["latest.json", { mode: "100644", bytes: pagesLatest }],
    ["SHA256SUMS.txt", { mode: "100644", bytes: pagesChecksums }],
    [historicalInstaller, { mode: "100644", bytes: Buffer.from("historical-installer") }],
    [`${historicalInstaller}.sig`, { mode: "100644", bytes: Buffer.from("historical-signature") }],
  ]);
  const productCommit = await createRootRepository(productRepository, "gh-pages", productFiles, {
    name: "github-actions[bot]",
    email: "41898282+github-actions[bot]@users.noreply.github.com",
    date: "2026-07-19T01:52:02.000Z",
    message: "Publish v0.8.3 update feed",
  });
  await git(["update-ref", "refs/heads/main", productCommit], productRepository);
  const productBundle = join(root, "product-before.bundle");
  await git(["bundle", "create", productBundle, "--all"], productRepository);

  const userSiteRepository = join(root, "user-site-source");
  const userSiteCommit = await createRootRepository(userSiteRepository, "main", new Map([
    ["README.md", { mode: "100644", bytes: Buffer.from("Personal site\n") }],
    ["CNAME", { mode: "100644", bytes: Buffer.from("leonlin.me\n") }],
    ["bin/keep.sh", { mode: "100755", bytes: Buffer.from("#!/bin/sh\necho keep\n") }],
  ]), {
    name: "Legacy Owner",
    email: "legacy@example.test",
    date: "2026-01-01T00:00:00.000Z",
    message: "Legacy user site",
  });
  const userSiteBundle = join(root, "user-site-before.bundle");
  await git(["bundle", "create", userSiteBundle, "--all"], userSiteRepository);

  const publicKey = Buffer.from("untrusted comment: test updater key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n");
  const tauriConfig = join(root, "tauri.conf.json");
  await writeFile(tauriConfig, `${JSON.stringify({ plugins: { updater: { pubkey: publicKey.toString("base64") } } }, null, 2)}\n`);
  await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"fake-verifier\"\nversion = \"0.0.0\"\n");
  await writeFile(join(root, "Cargo.lock"), "# deterministic fake lockfile\n");
  const cargoLog = join(root, "cargo-runs.jsonl");
  const cargoScript = join(root, "run");
  await writeFile(cargoScript, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const signature = fs.readFileSync(args.at(-2));",
    "const publicKey = fs.readFileSync(args.at(-1));",
    `fs.appendFileSync(${JSON.stringify(cargoLog)}, JSON.stringify({ args, cargoNetOffline: process.env.CARGO_NET_OFFLINE, signatureBase64: signature.toString('base64'), publicKeyBase64: publicKey.toString('base64') }) + '\\n');`,
  ].join("\n"));
  const signatureEvidence = join(root, "signature-evidence.json");
  await writeFile(signatureEvidence, `${JSON.stringify({
    schemaVersion: 1,
    verified: true,
    verifier: "cargo run --offline --locked --example verify_updater_signature",
    verifiedAt: "2026-08-08T17:18:10.000Z",
    installerSha256: installerHash,
    signatureFileSha256: sha256(signatureFile),
    decodedSignatureSha256: sha256(decodedSignature),
    updaterPublicKeySha256: sha256(publicKey),
  }, null, 2)}\n`);
  const signatureEvidenceSha256 = sha256(await readFile(signatureEvidence));

  return {
    root,
    releaseDirectory,
    releaseLatest,
    releaseChecksums,
    historicalInstaller,
    installerName,
    signature,
    publicKey,
    cargoLog,
    cargoScript,
    productCommit,
    options: {
      releaseDirectory,
      productBundle,
      productBundleSha256: sha256(await readFile(productBundle)),
      productGhPagesSha: productCommit,
      userSiteBundle,
      userSiteBundleSha256: sha256(await readFile(userSiteBundle)),
      userSiteMainSha: userSiteCommit,
      signatureEvidence,
      signatureEvidenceSha256,
      cargoExecutable: process.execPath,
      tauriConfig,
      canonicalOutput: join(root, "canonical-preseed"),
      userSiteOutput: join(root, "user-site-preseed"),
      evidenceOutput: join(root, "migration-evidence.json"),
      cnameDecision: "omit",
      identityName: identity.name,
      identityEmail: identity.email,
      commitDate: identity.date,
    },
  };
}

async function createRootRepository(directory, branch, files, metadata) {
  await mkdir(dirname(directory), { recursive: true });
  await git(["init", "--quiet", `--initial-branch=${branch}`, directory], dirname(directory), directory);
  for (const [path, entry] of files) {
    const target = join(directory, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
    const object = (await git(["hash-object", "-w", "--no-filters", "--", path], directory)).stdout.trim();
    await git(["update-index", "--add", "--cacheinfo", entry.mode, object, path], directory);
  }
  const tree = (await git(["write-tree"], directory)).stdout.trim();
  const commit = (await git(["commit-tree", tree, "-m", metadata.message], directory, directory, {
    GIT_AUTHOR_NAME: metadata.name,
    GIT_AUTHOR_EMAIL: metadata.email,
    GIT_AUTHOR_DATE: metadata.date,
    GIT_COMMITTER_NAME: metadata.name,
    GIT_COMMITTER_EMAIL: metadata.email,
    GIT_COMMITTER_DATE: metadata.date,
  })).stdout.trim();
  await git(["update-ref", `refs/heads/${branch}`, commit], directory);
  await git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], directory);
  return commit;
}

async function git(args, cwd, safeDirectory = cwd, extraEnvironment = {}) {
  const result = await execFileAsync("git", ["-c", `safe.directory=${resolve(safeDirectory)}`, "-c", "commit.gpgSign=false", ...args], {
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
  const root = await mkdtemp(join(tmpdir(), "kimi-feed-migration-test-"));
  try {
    return await callback(await createFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
