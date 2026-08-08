import assert from "node:assert/strict";
import test from "node:test";

import {
  findContentIssues,
  findForbiddenPath,
  findGitMetadataIssues,
  hasPrivateAuthorEmail,
  isPublicOriginRef,
  selectBlobEntries,
} from "./check-public-source.mjs";

test("rejects private paths with either slash style", () => {
  assert.ok(findForbiddenPath(".private/secrets.txt"));
  assert.ok(findForbiddenPath("credentials\\account.json"));
  assert.ok(findForbiddenPath("config/.tasty/session.json"));
  assert.ok(findForbiddenPath(".codex/session.json"));
  assert.ok(findForbiddenPath(".agents/logs/run.jsonl"));
  assert.ok(findForbiddenPath(".kimi-code/mcp.json"));
  assert.ok(findForbiddenPath("release\\windows\\signing.keystore"));
  assert.ok(findForbiddenPath(".npmrc"));
  assert.equal(findForbiddenPath(".env.example"), undefined);
  assert.equal(findForbiddenPath(".kimi-code/skills/review/SKILL.md"), undefined);
  assert.ok(findForbiddenPath(".kimi-code/skills/review/.env"));
});

test("detects representative secret and personal path patterns", () => {
  const githubToken = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
  const forwardPath = ["C:", "Users", "private", "project"].join("/");
  const backwardPath = ["C:", "Users", "private", "project"].join("\\");
  const escapedPath = JSON.stringify(backwardPath);
  const issues = findContentIssues(
    Buffer.from(`token = '${githubToken}'\n${forwardPath}`),
  );
  assert.ok(issues.includes("GitHub token"));
  assert.ok(issues.includes("personal Windows path"));
  assert.ok(findContentIssues(Buffer.from(backwardPath)).includes("personal Windows path"));
  assert.ok(findContentIssues(Buffer.from(escapedPath)).includes("personal Windows path"));
  assert.ok(findContentIssues(Buffer.from(`${githubToken}\0safe text`)).includes("GitHub token"));
  assert.ok(findContentIssues(Buffer.from(forwardPath, "utf16le")).includes("personal Windows path"));
  assert.deepEqual(findContentIssues(Buffer.from([0xff, 0x00, 0x01, 0x02, 0x03])), []);
});

test("detects consumer mailbox addresses in blob contents", () => {
  const email = ["developer", "gmail.com"].join("@");
  assert.ok(findContentIssues(Buffer.from(`contact: ${email}`)).includes("consumer email address"));

  const truncatedUtf16 = Buffer.concat([
    Buffer.from(`${["C:", "Users", "private", "project"].join("/")} ${email}`, "utf16le"),
    Buffer.from([0xff]),
  ]);
  const issues = findContentIssues(truncatedUtf16);
  assert.ok(issues.includes("personal Windows path"));
  assert.ok(issues.includes("consumer email address"));
});

test("preserves upstream copyright contacts without weakening security scans", () => {
  const emDash = String.fromCodePoint(0x2014);
  const githubToken = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
  const email = ["upstream-author", "gmail.com"].join("@");
  const windowsPath = ["C:", "Users", "private", "project"].join("/");
  const password = ["password", " = '", "abcdefghijklmnop", "'"].join("");
  const paths = [
    `third_party/licenses/texts/${"a".repeat(64)}.txt`,
    "third_party/node/v22.22.2/LICENSE.txt",
  ];

  for (const path of paths) {
    assert.deepEqual(
      findContentIssues(Buffer.from(`Copyright (c) Upstream Author <${email}>${emDash}`), path),
      [],
    );
    const issues = findContentIssues(Buffer.from(`${githubToken}\n${windowsPath}\n${password}`), path);
    assert.ok(issues.includes("GitHub token"));
    assert.ok(issues.includes("personal Windows path"));
    assert.ok(issues.includes("literal credential assignment"));
    assert.ok(
      findContentIssues(Buffer.from(`Contact: ${email}`), path).includes("consumer email address"),
    );
  }

  assert.ok(
    findContentIssues(
      Buffer.from(`Copyright (c) Upstream Author <${email}>`),
      "third_party/licenses/texts/not-a-content-hash.txt",
    ).includes("consumer email address"),
  );
});

test("flags consumer mailbox author metadata without flagging noreply addresses", () => {
  const email = ["developer", "gmail.com"].join("@");
  assert.equal(hasPrivateAuthorEmail(email), true);
  assert.equal(hasPrivateAuthorEmail(`<${email}>`), true);
  assert.equal(hasPrivateAuthorEmail("123+developer@users.noreply.github.com"), false);
});

test("checks commit and tag messages plus every Git identity role", () => {
  const token = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
  const taggerEmail = ["tagger", "gmail.com"].join("@");
  expectMetadataIssue({ authorEmail: ["author", "gmail.com"].join("@") }, "personal author email");
  expectMetadataIssue({ committerEmail: ["committer", "gmail.com"].join("@") }, "personal committer email");
  expectMetadataIssue({ taggerEmail: `<${taggerEmail}>` }, "personal tagger email");
  expectMetadataIssue({ message: `release ${token}` }, "message contains GitHub token");
});

test("detects consumer addresses inside commit and tag messages", () => {
  const email = ["contributor", "gmail.com"].join("@");
  expectMetadataIssue(
    { message: `Co-authored-by: Contributor <${email}>` },
    "message contains consumer email address",
  );
});

test("retains pathless blob objects while excluding commits and trees", () => {
  const entries = [
    { objectId: "blob-tag-target", path: "" },
    { objectId: "commit", path: "" },
    { objectId: "tree", path: "src" },
  ];
  const types = new Map([["blob-tag-target", "blob"], ["commit", "commit"], ["tree", "tree"]]);
  assert.deepEqual(selectBlobEntries(entries, types), [entries[0]]);
});

function expectMetadataIssue(metadata, issue) {
  assert.ok(findGitMetadataIssues(metadata).includes(issue));
}

test("includes public origin branches without scanning local or symbolic refs", () => {
  assert.equal(isPublicOriginRef("refs/remotes/origin/main"), true);
  assert.equal(isPublicOriginRef("refs/remotes/origin/release/v1"), true);
  assert.equal(isPublicOriginRef("refs/remotes/origin/HEAD"), false);
  assert.equal(isPublicOriginRef("refs/heads/private-checkpoint"), false);
  assert.equal(isPublicOriginRef("refs/remotes/fork/main"), false);
});
