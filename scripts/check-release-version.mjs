import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const anchors = [
  ["desktop package", "apps/desktop/package.json", (text) => JSON.parse(text).version],
  ["Cargo package", "apps/desktop/src-tauri/Cargo.toml", packageVersion],
  ["Cargo lock", "apps/desktop/src-tauri/Cargo.lock", lockedPackageVersion],
  ["Tauri config", "apps/desktop/src-tauri/tauri.conf.json", (text) => JSON.parse(text).version],
  ["ACP client", "apps/server/src/acp-client.ts", (text) => capture(text, /clientInfo:\s*\{[^}\n]*\bversion:\s*["']([^"']+)/, "ACP client version")],
  ["Preview MCP", "apps/server/src/preview-mcp.ts", (text) => capture(text, /serverInfo:\s*\{[^}\n]*\bversion:\s*["']([^"']+)/, "Preview MCP version")],
];

export async function checkReleaseVersion(root, expectedInput) {
  const versions = await Promise.all(anchors.map(async ([label, path, parse]) => {
    const version = parse(await readFile(join(root, path), "utf8"));
    if (typeof version !== "string" || !version) throw new Error(`${label} has no version`);
    return [label, path, version];
  }));
  const expected = normalizeVersion(expectedInput) ?? versions[0][2];
  const mismatches = versions.filter(([, , version]) => version !== expected);
  if (mismatches.length) {
    throw new Error([`Expected release version ${expected}:`, ...versions.map(([label, path, version]) => `- ${label}: ${version} (${path})`)].join("\n"));
  }
  const releaseNotes = `docs/releases/v${expected}.md`;
  await access(join(root, releaseNotes));
  return { version: expected, releaseNotes, anchors: versions.length };
}

function normalizeVersion(input) {
  if (input === undefined || input === "") return undefined;
  const version = input.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${input}`);
  }
  return version;
}

function capture(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not find ${label}`);
  return match[1];
}

function packageVersion(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[package]");
  if (start < 0) throw new Error("Could not find Cargo package section");
  const end = lines.findIndex((line, index) => index > start && /^\[.+\]$/.test(line.trim()));
  const block = lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  return capture(block, /^version\s*=\s*"([^"]+)"/m, "Cargo package version");
}

function lockedPackageVersion(text) {
  const block = text.split(/\r?\n(?=\[\[package\]\])/).find((candidate) => /^name\s*=\s*"kimi-code-desktop"\s*$/m.test(candidate));
  if (!block) throw new Error("Could not find kimi-code-desktop in Cargo.lock");
  return capture(block, /^version\s*=\s*"([^"]+)"/m, "Cargo lock version");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  checkReleaseVersion(root, process.argv[2] ?? process.env.RELEASE_VERSION).then(
    ({ version, anchors: count, releaseNotes }) => console.log(`Release ${version}: ${count} version anchors agree; ${releaseNotes} exists.`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
