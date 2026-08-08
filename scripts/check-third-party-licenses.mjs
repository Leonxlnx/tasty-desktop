import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "third_party", "licenses");
const inventoryPath = join(output, "inventory.json");
const textsPath = join(output, "texts");
const cargoManifest = join(root, "apps", "desktop", "src-tauri", "Cargo.toml");
const windowsTarget = "x86_64-pc-windows-msvc";
const licenseFilePattern = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[-._])/i;
const generatedTextPattern = /^[0-9a-f]{64}\.txt$/;

// These crates omit a root license file from their published archive. Each
// fallback was reviewed against the exact locked source and stays versioned so
// a dependency update fails closed until its evidence is reviewed again.
const reviewedRustFallbacks = new Map([
  ["alloc-stdlib@0.2.4", [
    { package: "alloc-no-stdlib@2.0.4", file: "LICENSE", kind: "same-repository-license" },
  ]],
  ["selectors@0.36.1", [
    { package: "cssparser@0.36.0", file: "LICENSE", kind: "canonical-MPL-2.0" },
    { package: "selectors@0.36.1", file: "lib.rs", kind: "source-license-notice" },
  ]],
  ["tauri-plugin@2.6.3", [
    { package: "tauri@2.11.5", file: "LICENSE_APACHE-2.0", kind: "same-repository-license" },
    { package: "tauri-plugin@2.6.3", file: "src/lib.rs", kind: "source-license-notice" },
  ]],
  ...[
    "unic-char-property",
    "unic-char-range",
    "unic-common",
    "unic-ucd-ident",
    "unic-ucd-version",
  ].map((name) => [`${name}@0.9.0`, [
    { package: "tauri@2.11.5", file: "LICENSE_APACHE-2.0", kind: "canonical-Apache-2.0" },
    { package: `${name}@0.9.0`, file: name === "unic-common" ? "src/lib.rs" : "src/pkg_info.rs", kind: "source-license-notice" },
  ]]),
  ["webview2-com@0.38.2", [{
    workspaceFile: "third_party/licenses/upstream/webview2-rs-LICENSE",
    sourceUrl: "https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE",
    expectedSha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
    kind: "exact-upstream-license",
  }]],
  ["webview2-com-sys@0.38.2", [{
    workspaceFile: "third_party/licenses/upstream/webview2-rs-LICENSE",
    sourceUrl: "https://raw.githubusercontent.com/wravery/webview2-rs/b74dc5e2b394044bea5191052868ce7a106c202c/LICENSE",
    expectedSha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
    kind: "exact-upstream-license",
  }]],
  ["webview2-com-macros@0.8.1", [{
    workspaceFile: "third_party/licenses/upstream/webview2-rs-LICENSE",
    sourceUrl: "https://raw.githubusercontent.com/wravery/webview2-rs/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE",
    expectedSha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73",
    kind: "exact-upstream-license",
  }]],
  ["siphasher@1.0.3", [
    {
      workspaceFile: "third_party/licenses/upstream/siphasher-1.0.3-COPYING",
      sourceUrl: "https://raw.githubusercontent.com/jedisct1/rust-siphash/451f67d73a772cba325728109bbfa247750ed076/COPYING",
      expectedSha256: "c962ee4d1d05ddc138b202b2540219ebc57893fcf97b364852094a9a94ce1365",
      kind: "exact-upstream-notice",
    },
    {
      workspaceFile: "third_party/licenses/upstream/Apache-2.0.txt",
      sourceUrl: "https://www.apache.org/licenses/LICENSE-2.0.txt",
      expectedSha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
      kind: "canonical-Apache-2.0",
    },
  ]],
]);
const replaceRustEvidence = new Set(["siphasher@1.0.3"]);
const reviewedLicenseOptions = new Map([["siphasher@1.0.3", "Apache-2.0"]]);

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const normalizeLineEndings = (content) => content.replace(/\r\n?/g, "\n");
export const normalizedLockfileHash = (content) => sha256(normalizeLineEndings(content));
const slash = (path) => path.replaceAll("\\", "/");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isInside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
export function assertReviewedHash(content, expected, label) {
  const actual = sha256(content);
  if (actual !== expected) throw new Error(`Reviewed license evidence changed: ${label} (expected ${expected}, found ${actual})`);
  return actual;
}
export function generatedTextDrift(actualNames, expectedHashes) {
  const expected = new Set([...expectedHashes].map((hash) => `${hash}.txt`));
  const actual = new Set(actualNames);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(compare),
    extras: [...actual].filter((name) => !expected.has(name)).sort(compare),
  };
}
export function licenseRootDrift(actualNames) {
  const expected = new Set(["inventory.json", "texts", "upstream"]);
  const actual = new Set(actualNames);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(compare),
    extras: [...actual].filter((name) => !expected.has(name)).sort(compare),
  };
}
export function assertLicenseRootEntries(entries) {
  const drift = licenseRootDrift(entries.map((entry) => entry.name));
  const invalidTypes = entries.filter((entry) =>
    entry.name === "inventory.json" ? !entry.isFile() : ["texts", "upstream"].includes(entry.name) && !entry.isDirectory()
  ).map((entry) => entry.name).sort(compare);
  if (drift.missing.length || drift.extras.length || invalidTypes.length) {
    throw new Error(`Third-party license root changed:\n- ${[
      ...drift.missing.map((name) => `missing ${name}`),
      ...drift.extras.map((name) => `unreferenced ${name}`),
      ...invalidTypes.map((name) => `invalid entry type for ${name}`),
    ].join("\n- ")}`);
  }
}
const normalizeLicense = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeLicense).filter(Boolean).join(" OR ");
  if (value && typeof value.type === "string") return value.type;
  return null;
};

export function parseCargoTree(text) {
  const packages = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.+-]+) v([^\s]+)/.exec(line.trim());
    if (match) packages.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
  }
  return [...packages.values()]
    .filter((entry) => entry.name !== "kimi-code-desktop")
    .sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`));
}

export function parseCargoPackage(toml) {
  const afterHeader = toml.split(/^\[package\]\s*$/m, 2)[1] ?? "";
  const packageBlock = afterHeader.split(/^\[/m, 1)[0];
  const field = (name) => new RegExp(`^${name.replace("-", "\\-")}\\s*=\\s*"([^"]+)"`, "m").exec(packageBlock)?.[1] ?? null;
  return { license: field("license"), licenseFile: field("license-file"), repository: field("repository") };
}

async function findLicenseFiles(packageDir, declaredFile) {
  const candidates = new Set();
  if (declaredFile) candidates.add(declaredFile);
  for (const entry of await readdir(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && licenseFilePattern.test(entry.name)) candidates.add(entry.name);
  }
  const files = [];
  for (const name of [...candidates].sort()) {
    const path = resolve(packageDir, name);
    if (!isInside(packageDir, path)) continue;
    if (!existsSync(path)) continue;
    const content = await readFile(path);
    if (content.length) files.push({ name: slash(name), kind: "package-license", content });
  }
  return files;
}

async function resolveNodeDependency(from, name) {
  let cursor = resolve(from);
  while (true) {
    const candidate = join(cursor, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpath(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Installed JavaScript dependency not found: ${name} (from ${from})`);
    cursor = parent;
  }
}

async function collectJavaScript() {
  const records = new Map();
  const visited = new Set();
  const visit = async (packageDir) => {
    const canonical = await realpath(packageDir);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const metadata = JSON.parse(await readFile(join(canonical, "package.json"), "utf8"));
    const key = `${metadata.name}@${metadata.version}`;
    const files = await findLicenseFiles(canonical, null);
    records.set(key, {
      ecosystem: "javascript",
      name: metadata.name,
      version: metadata.version,
      license: normalizeLicense(metadata.license ?? metadata.licenses),
      repository: typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url ?? null,
      files,
    });
    const dependencies = { ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      try {
        await visit(await resolveNodeDependency(canonical, name));
      } catch (error) {
        if (!metadata.optionalDependencies?.[name] && !metadata.peerDependenciesMeta?.[name]?.optional) throw error;
      }
    }
  };
  for (const workspace of ["apps/server", "apps/web"]) {
    const directory = join(root, workspace);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    for (const name of Object.keys(metadata.dependencies ?? {}).sort()) {
      await visit(await resolveNodeDependency(directory, name));
    }
  }
  return records;
}

async function cargoSourceMap() {
  const cargoHome = process.env.CARGO_HOME ? resolve(process.env.CARGO_HOME) : join(homedir(), ".cargo");
  const registry = join(cargoHome, "registry", "src");
  const result = new Map();
  for (const index of await readdir(registry, { withFileTypes: true })) {
    if (!index.isDirectory()) continue;
    const indexPath = join(registry, index.name);
    for (const entry of await readdir(indexPath, { withFileTypes: true })) {
      if (entry.isDirectory()) result.set(entry.name, join(indexPath, entry.name));
    }
  }
  return result;
}

async function collectRust() {
  const tree = spawnSync("cargo", [
    "tree", "--locked", "--offline", "--target", windowsTarget,
    "--manifest-path", cargoManifest, "--prefix", "none", "-e", "normal,build", "--format", "{p}",
  ], { cwd: root, encoding: "utf8" });
  if (tree.status !== 0) throw new Error(`Cargo license graph failed. Fetch the locked Windows target first.\n${tree.stderr.trim()}`);
  const sources = await cargoSourceMap();
  const records = new Map();
  for (const item of parseCargoTree(tree.stdout)) {
    const key = `${item.name}@${item.version}`;
    const packageDir = sources.get(`${item.name}-${item.version}`);
    if (!packageDir) throw new Error(`Locked Rust source is absent from the local Cargo cache: ${key}`);
    const metadata = parseCargoPackage(await readFile(join(packageDir, "Cargo.toml"), "utf8"));
    records.set(key, {
      ecosystem: "rust",
      ...item,
      license: metadata.license,
      repository: metadata.repository,
      packageDir,
      files: await findLicenseFiles(packageDir, metadata.licenseFile),
    });
  }
  for (const [key, fallbacks] of reviewedRustFallbacks) {
    const record = records.get(key);
    if (!record) continue;
    if (replaceRustEvidence.has(key)) record.files = [];
    else if (record.files.length) continue;
    if (reviewedLicenseOptions.has(key)) record.reviewedLicenseOption = reviewedLicenseOptions.get(key);
    for (const fallback of fallbacks) {
      if (fallback.workspaceFile) {
        const path = join(root, ...fallback.workspaceFile.split("/"));
        if (!isInside(root, path) || !existsSync(path)) throw new Error(`Reviewed upstream license evidence is absent: ${fallback.workspaceFile}`);
        const content = await readFile(path);
        if (!fallback.expectedSha256) throw new Error(`Reviewed upstream evidence has no pinned hash: ${fallback.workspaceFile}`);
        assertReviewedHash(content, fallback.expectedSha256, fallback.workspaceFile);
        record.files.push({
          name: fallback.workspaceFile,
          kind: fallback.kind,
          sourceUrl: fallback.sourceUrl,
          content,
        });
        continue;
      }
      const source = records.get(fallback.package);
      if (!source) throw new Error(`Reviewed license evidence is no longer in the locked Windows graph: ${fallback.package}`);
      const path = resolve(source.packageDir, fallback.file);
      if (!isInside(source.packageDir, path) || !existsSync(path)) {
        throw new Error(`Reviewed license evidence is absent: ${fallback.package}/${fallback.file}`);
      }
      record.files.push({
        name: `${fallback.package}/${slash(fallback.file)}`,
        kind: fallback.kind,
        content: await readFile(path),
      });
    }
  }
  return records;
}

async function buildInventory() {
  const records = [...(await collectJavaScript()).values(), ...(await collectRust()).values()]
    .sort((a, b) => compare(`${a.ecosystem}:${a.name}@${a.version}`, `${b.ecosystem}:${b.name}@${b.version}`));
  const evidence = new Map();
  const packages = records.map(({ packageDir: _packageDir, files, ...record }) => ({
    ...record,
    licenseFiles: files.map(({ content, ...file }) => {
      const hash = sha256(content);
      evidence.set(hash, content);
      return { ...file, sha256: hash, path: `texts/${hash}.txt` };
    }),
  }));
  const missing = packages.filter((entry) => !entry.license || !entry.licenseFiles.length).map((entry) => ({
    ecosystem: entry.ecosystem,
    package: `${entry.name}@${entry.version}`,
    reason: entry.license ? "published package contains no reviewed license or notice text" : "package metadata declares no license",
  }));
  return {
    inventory: {
      schemaVersion: 1,
      scope: {
        javascript: ["apps/server production bundle", "apps/web production bundle"],
        rust: `apps/desktop Windows ${windowsTarget} normal and build graph`,
        lockfiles: {
          "pnpm-lock.yaml": normalizedLockfileHash(await readFile(join(root, "pnpm-lock.yaml"), "utf8")),
          "apps/desktop/src-tauri/Cargo.lock": normalizedLockfileHash(await readFile(join(root, "apps", "desktop", "src-tauri", "Cargo.lock"), "utf8")),
        },
      },
      status: missing.length ? "blocked" : "complete",
      packages,
      missing,
    },
    evidence,
  };
}

async function verifyEvidence(inventory) {
  const failures = [];
  for (const entry of inventory.packages) {
    for (const file of entry.licenseFiles) {
      const path = join(output, ...file.path.split("/"));
      if (!existsSync(path)) failures.push(`${entry.name}@${entry.version}: missing ${file.path}`);
      else if (sha256(await readFile(path)) !== file.sha256) failures.push(`${entry.name}@${entry.version}: hash mismatch for ${file.path}`);
    }
  }
  const entries = existsSync(textsPath) ? await readdir(textsPath, { withFileTypes: true }) : [];
  const drift = generatedTextDrift(
    entries.map((entry) => entry.name),
    inventory.packages.flatMap((entry) => entry.licenseFiles.map((file) => file.sha256)),
  );
  failures.push(...drift.missing.map((name) => `missing generated license text: ${name}`));
  failures.push(...drift.extras.map((name) => `unreferenced license text: ${name}`));
  failures.push(...entries.filter((entry) => !entry.isFile()).map((entry) => `license text is not a regular file: ${entry.name}`));
  return failures;
}

async function removeStaleGeneratedTexts(expectedHashes) {
  if (!existsSync(textsPath)) return;
  const expected = new Set([...expectedHashes].map((hash) => `${hash}.txt`));
  for (const entry of await readdir(textsPath, { withFileTypes: true })) {
    if (!entry.isFile() || !generatedTextPattern.test(entry.name) || expected.has(entry.name)) continue;
    const path = join(textsPath, entry.name);
    if (!isInside(textsPath, path)) throw new Error(`Refusing to remove license text outside generated directory: ${path}`);
    await unlink(path);
  }
}

async function verifyPinnedSources() {
  const pinnedRoot = join(output, "upstream");
  const expected = new Set([...reviewedRustFallbacks.values()].flat()
    .map((entry) => entry.workspaceFile)
    .filter(Boolean)
    .map((path) => path.split("/").at(-1)));
  const actual = existsSync(pinnedRoot) ? await readdir(pinnedRoot, { withFileTypes: true }) : [];
  const failures = {
    missing: [...expected].filter((name) => !actual.some((entry) => entry.name === name)).sort(compare),
    extras: actual.filter((entry) => !expected.has(entry.name) || !entry.isFile()).map((entry) => entry.name).sort(compare),
  };
  if (failures.missing.length || failures.extras.length) {
    throw new Error(`Pinned license source set changed:\n- ${[
      ...failures.missing.map((name) => `missing ${name}`),
      ...failures.extras.map((name) => `unreferenced ${name}`),
    ].join("\n- ")}`);
  }
}

async function verifyLicenseRoot() {
  const entries = existsSync(output) ? await readdir(output, { withFileTypes: true }) : [];
  assertLicenseRootEntries(entries);
}

async function main() {
  const { inventory, evidence } = await buildInventory();
  await verifyPinnedSources();
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await mkdir(textsPath, { recursive: true });
    await removeStaleGeneratedTexts(evidence.keys());
    await Promise.all([...evidence].map(([hash, content]) => writeFile(join(textsPath, `${hash}.txt`), content)));
    const failures = await verifyEvidence(inventory);
    if (failures.length) throw new Error(`Third-party license evidence is invalid:\n- ${failures.join("\n- ")}`);
    await writeFile(inventoryPath, serialized);
    await verifyLicenseRoot();
    console.log(`Wrote ${inventory.packages.length} package records and ${evidence.size} exact license texts.`);
  } else {
    await verifyLicenseRoot();
    const committed = existsSync(inventoryPath) ? await readFile(inventoryPath, "utf8") : "";
    if (normalizeLineEndings(committed) !== serialized) throw new Error("Third-party license inventory is stale. Run `corepack pnpm@10.13.1 licenses:write` and review the diff.");
    const failures = await verifyEvidence(inventory);
    if (failures.length) throw new Error(`Third-party license evidence is invalid:\n- ${failures.join("\n- ")}`);
  }
  if (inventory.missing.length) {
    throw new Error(`Release blocked by missing third-party license evidence:\n- ${inventory.missing.map((item) => `${item.ecosystem}:${item.package}: ${item.reason}`).join("\n- ")}`);
  }
  console.log(`Third-party licenses verified for ${inventory.packages.length} shipped package records.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
