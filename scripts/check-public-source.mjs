import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

const PRIVATE_ROOT_FILES = new Set([
  "decisions.md",
  "handoff.md",
  "progress.md",
  "supervisor.md",
  "tasks.json",
]);
const PRIVATE_PREFIXES = ["docs/spec/", "docs/reference/"];
const PRIVATE_SEGMENTS = new Set([
  ".agents",
  ".codex",
  ".private",
  ".tasty",
  "credentials",
  "keystore",
  "keystores",
]);
const PRIVATE_BASENAMES = new Set([
  ".npmrc",
  "credentials.json",
  "key.properties",
  "keystore.properties",
  "service-account.json",
]);
const PRIVATE_EXTENSIONS = [".jks", ".key", ".keystore", ".p12", ".pem", ".pfx"];

const PERSONAL_EMAIL_DOMAINS = /@(?:gmail\.com|googlemail\.com|hotmail\.[a-z.]+|icloud\.com|live\.[a-z.]+|me\.com|outlook\.com|proton(?:mail)?\.(?:com|me)|yahoo\.[a-z.]+)$/i;
const PERSONAL_EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|hotmail\.[a-z.]+|icloud\.com|live\.[a-z.]+|me\.com|outlook\.com|proton(?:mail)?\.(?:com|me)|yahoo\.[a-z.]+)(?=$|[^A-Z0-9.-])/i;
const GENERATED_LICENSE_TEXT = /^third_party\/licenses\/texts\/[0-9a-f]{64}\.txt$/u;
const BUNDLED_NODE_LICENSE = /^third_party\/node\/v\d+\.\d+\.\d+\/license\.txt$/u;

const CONTENT_CHECKS = [
  ["Unicode em dash", /\u2014/u],
  ["private key block", /-----BEGIN (?:(?:DSA|EC|ENCRYPTED|OPENSSH|PGP|RSA) )?PRIVATE KEY(?: BLOCK)?-----/i],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["OpenAI-style secret", /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Stripe live secret", /\b(?:rk|sk)_live_[A-Za-z0-9]{16,}\b/],
  ["literal bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i],
  ["credential in URL", /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  [
    "literal credential assignment",
    /\b(?:access[_-]?token|api[_-]?key|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'`](?!changeme|dummy|example|placeholder|replace|test|your[-_])[A-Za-z0-9_./+=-]{16,}["'`]/i,
  ],
  ["personal Windows path", /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+/i],
  ["consumer email address", PERSONAL_EMAIL_IN_TEXT],
  ["German phone number", /\+49[\s-]*\d{6,}/],
];

export function findForbiddenPath(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const isPublicKimiSkill = normalized.startsWith(".kimi-code/skills/");

  if (PRIVATE_ROOT_FILES.has(normalized) || PRIVATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "private project material is tracked";
  }
  if (segments.some((segment) => PRIVATE_SEGMENTS.has(segment))) {
    return "private directory is tracked";
  }
  if (segments.includes(".kimi-code") && !isPublicKimiSkill) {
    return "private Kimi runtime material is tracked";
  }
  if (
    PRIVATE_BASENAMES.has(basename) ||
    (basename.startsWith(".env") && basename !== ".env.example") ||
    PRIVATE_EXTENSIONS.some((extension) => basename.endsWith(extension))
  ) {
    return "credential or signing file is tracked";
  }
  return undefined;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF16LE_DECODER = new TextDecoder("utf-16le", { fatal: true });
const UTF16BE_DECODER = new TextDecoder("utf-16be", { fatal: true });

function utf16Decoder(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return UTF16LE_DECODER;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return UTF16BE_DECODER;

  const pairs = Math.min(Math.floor(bytes.length / 2), 2048);
  if (pairs < 4) return undefined;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < pairs * 2; index += 2) {
    if (bytes[index] === 0) evenZeros += 1;
    if (bytes[index + 1] === 0) oddZeros += 1;
  }
  if (oddZeros / pairs >= 0.5 && evenZeros / pairs <= 0.1) return UTF16LE_DECODER;
  if (evenZeros / pairs >= 0.5 && oddZeros / pairs <= 0.1) return UTF16BE_DECODER;
  return undefined;
}

function asciiRuns(bytes) {
  return bytes.toString("latin1").match(/[\t\n\r\x20-\x7e]{4,}/g)?.join("\n") ?? "";
}

function scannableText(bytes) {
  const decoder = utf16Decoder(bytes);
  if (decoder) {
    try {
      return decoder.decode(bytes).replaceAll("\0", "\n");
    } catch {
      return new TextDecoder(decoder.encoding).decode(bytes).replaceAll("\0", "\n");
    }
  }

  try {
    const text = UTF8_DECODER.decode(bytes);
    let controls = 0;
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code < 32 && character !== "\0" && character !== "\t" && character !== "\n" && character !== "\r") {
        controls += 1;
      }
    }
    return controls <= Math.max(2, text.length * 0.02)
      ? text.replaceAll("\0", "\n")
      : asciiRuns(bytes);
  } catch {
    return asciiRuns(bytes);
  }
}

function isReviewedUpstreamLicenseText(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  return GENERATED_LICENSE_TEXT.test(normalized) || BUNDLED_NODE_LICENSE.test(normalized);
}

function hasConsumerEmailOutsideCopyrightLine(text) {
  const pattern = new RegExp(PERSONAL_EMAIL_IN_TEXT.source, "giu");
  for (const match of text.matchAll(pattern)) {
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const nextLineBreak = text.indexOf("\n", match.index);
    const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
    if (!/\bcopyright\b/iu.test(text.slice(lineStart, lineEnd))) return true;
  }
  return false;
}

export function findContentIssues(bytes, file = "") {
  const text = scannableText(bytes);
  const preservesUpstreamLicenseText = isReviewedUpstreamLicenseText(file);
  return CONTENT_CHECKS
    .filter(([label, pattern]) => {
      if (preservesUpstreamLicenseText && label === "Unicode em dash") return false;
      if (
        preservesUpstreamLicenseText &&
        label === "consumer email address" &&
        !hasConsumerEmailOutsideCopyrightLine(text)
      ) return false;
      return pattern.test(text);
    })
    .map(([label]) => label);
}

export function hasPrivateAuthorEmail(email) {
  return PERSONAL_EMAIL_DOMAINS.test(email.trim().replace(/^<|>$/gu, ""));
}

export function findGitMetadataIssues({ authorEmail = "", committerEmail = "", taggerEmail = "", message = "" }) {
  const issues = [];
  if (hasPrivateAuthorEmail(authorEmail)) issues.push("personal author email");
  if (hasPrivateAuthorEmail(committerEmail)) issues.push("personal committer email");
  if (hasPrivateAuthorEmail(taggerEmail)) issues.push("personal tagger email");
  for (const issue of findContentIssues(Buffer.from(message))) issues.push(`message contains ${issue}`);
  return issues;
}

export function selectBlobEntries(entries, objectTypes) {
  return entries.filter(({ objectId }) => objectTypes.get(objectId) === "blob");
}

export function isPublicOriginRef(ref) {
  return ref.startsWith("refs/remotes/origin/") && ref !== "refs/remotes/origin/HEAD";
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, ...options });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return "";
  }
}

function readPublicHistory(publicRefs) {
  if (publicRefs.length === 0) return [];

  const entries = git(["rev-list", "--objects", "--filter=object:type=blob", ...publicRefs])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1
        ? { objectId: line, path: "" }
        : { objectId: line.slice(0, separator), path: line.slice(separator + 1) };
    });
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.objectId, entry])).values()];
  if (uniqueEntries.length === 0) return [];
  const objectTypes = new Map(git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: Buffer.from(`${uniqueEntries.map(({ objectId }) => objectId).join("\n")}\n`),
  }).trim().split(/\r?\n/u).map((line) => {
    const separator = line.indexOf(" ");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const blobEntries = selectBlobEntries(uniqueEntries, objectTypes);
  if (blobEntries.length === 0) return [];
  const output = git(["cat-file", "--batch"], {
    encoding: null,
    input: Buffer.from(`${blobEntries.map(({ objectId }) => objectId).join("\n")}\n`),
  });
  const blobs = [];
  let offset = 0;

  for (const entry of blobEntries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) throw new Error("Invalid git cat-file response");
    const [objectId, type, sizeText] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(sizeText);
    if (objectId !== entry.objectId || !Number.isSafeInteger(size)) {
      throw new Error("Invalid git cat-file object header");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (type === "blob") blobs.push({ ...entry, bytes: output.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }

  return blobs;
}

function readCommitMetadata(publicRefs) {
  if (publicRefs.length === 0) return [];
  const fields = git(["log", "-z", "--format=%H%x00%ae%x00%ce%x00%B", ...publicRefs, "--"]).split("\0");
  const records = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    records.push({
      source: fields[index].slice(0, 12),
      authorEmail: fields[index + 1],
      committerEmail: fields[index + 2],
      message: fields[index + 3],
    });
  }
  return records;
}

function readTagMetadata() {
  const fields = git([
    "for-each-ref",
    "--format=%(refname)%00%(objecttype)%00%(if:equals=tag)%(objecttype)%(then)%(taggeremail)%(end)%00%(if:equals=tag)%(objecttype)%(then)%(contents)%(end)%00",
    "refs/tags",
  ]).split("\0");
  const records = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const source = fields[index].replace(/^\r?\n/u, "");
    if (!source) continue;
    records.push({ source, taggerEmail: fields[index + 2], message: fields[index + 3] });
  }
  return records;
}

function run() {
  const findings = new Set();
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((file) => file && existsSync(file));

  for (const file of files) {
    const pathIssue = findForbiddenPath(file);
    if (pathIssue) findings.add(`${file}: ${pathIssue}`);
    for (const issue of findContentIssues(readFileSync(file), file)) findings.add(`${file}: ${issue}`);
  }

  const tags = tryGit(["for-each-ref", "--format=%(refname)", "refs/tags"])
    .split(/\r?\n/u)
    .filter(Boolean);
  const originRefs = tryGit(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"])
    .split(/\r?\n/u)
    .filter(isPublicOriginRef);
  const publicRefs = [...new Set([
    ...(tryGit(["rev-parse", "--verify", "HEAD^{commit}"]) ? ["HEAD"] : []),
    ...tags,
    ...originRefs,
  ])];
  const commitRefs = publicRefs.filter((ref) => tryGit(["rev-parse", "--verify", `${ref}^{commit}`]));
  const historyBlobs = readPublicHistory(publicRefs);

  const historyPaths = commitRefs.length
    ? git(["log", "-z", "--format=", "--name-only", "--no-renames", ...commitRefs, "--"])
        .split("\0")
        .map((path) => path.replace(/^\r?\n/u, ""))
        .filter(Boolean)
    : [];
  for (const path of historyPaths) {
    const pathIssue = findForbiddenPath(path);
    if (pathIssue) findings.add(`${path}: ${pathIssue} in public history`);
  }

  for (const { objectId, path, bytes } of historyBlobs) {
    const source = path || objectId.slice(0, 12);
    for (const issue of findContentIssues(bytes, path)) findings.add(`${source}: ${issue} in public history`);
  }

  for (const { source, ...metadata } of readCommitMetadata(commitRefs)) {
    for (const issue of findGitMetadataIssues(metadata)) {
      findings.add(`${source}: ${issue} in public commit metadata`);
    }
  }
  for (const { source, ...metadata } of readTagMetadata()) {
    for (const issue of findGitMetadataIssues(metadata)) {
      findings.add(`${source}: ${issue} in public tag metadata`);
    }
  }

  if (findings.size > 0) {
    console.error("Public-source guard failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Public-source guard passed for ${files.length} working-tree files and ${historyBlobs.length} blobs reachable from HEAD, tags, and origin branches.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
