import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => file && existsSync(file));

const forbiddenFiles = new Set([
  "DECISIONS.md",
  "HANDOFF.md",
  "PROGRESS.md",
  "SUPERVISOR.md",
  "TASKS.json",
]);
const forbiddenPrefixes = ["docs/spec/", "docs/reference/"];

const findings = [];

for (const file of files) {
  if (forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    findings.push(`${file}: private project material is tracked`);
    continue;
  }

  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;

  const text = bytes.toString("utf8");
  const checks = [
    ["Unicode em dash", /\u2014/u],
    ["private key block", /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i],
    ["GitHub token", /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/i],
    ["OpenAI-style secret", /sk-[A-Za-z0-9_-]{20,}/i],
    ["AWS access key", /AKIA[0-9A-Z]{16}/],
    ["personal Windows path", /[A-Za-z]:\\Users\\[^\\\r\n]+/i],
    ["German phone number", /\+49[\s-]*\d{6,}/],
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error("Public-source guard failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public-source guard passed for ${files.length} tracked files.`);
