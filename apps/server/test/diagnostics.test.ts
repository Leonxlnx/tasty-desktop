import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DiagnosticJournal, redactDiagnosticText, redactPrivateErrorText } from "../src/diagnostics.js";

describe("diagnostic support bundles", () => {
  it("bounds and redacts secrets and local home paths", async () => {
    const home = "C:\\FixtureProfiles\\ExampleUser";
    const journal = new DiagnosticJournal([home]);
    const record = journal.record("error", `Bearer secret-token token=abc123 ${home} ${"x".repeat(3_000)}`, "runtime");
    expect(record.message).not.toContain("secret-token");
    expect(record.message).not.toContain("abc123");
    expect(record.message).not.toContain(home);
    expect(record.message.length).toBeLessThanOrEqual(2_000);

    const directory = await mkdtemp(join(tmpdir(), "tasty-diagnostics-"));
    const path = await journal.export(directory, { platform: "win32", runtimeCount: 1 });
    const contents = await readFile(path, "utf8");
    expect(contents).toContain("[redacted]");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain(home);
    expect((await stat(path)).isFile()).toBe(true);
  });

  it("redacts common provider tokens", () => {
    expect(redactDiagnosticText("api_key=provider-secret-value-1234567890")).toBe("api_key=[redacted]");
    expect(redactDiagnosticText("https://host.test/path?token=top-secret&ok=1")).toBe("https://host.test/path?token=[redacted]&ok=1");
  });

  it("redacts quoted credentials, authorization values, and real GitHub token formats", () => {
    const githubToken = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const fineGrainedToken = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const bearerHeader = ["Authorization: Bearer ", "eyJhbGciOiJIUzI1NiJ9.payload.signature"].join("");

    expect(redactDiagnosticText('{"token":"json-secret","credentials":"login-secret"}')).toBe('{"token":"[redacted]","credentials":"[redacted]"}');
    expect(redactDiagnosticText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
    expect(redactDiagnosticText(bearerHeader)).toBe("Authorization: [redacted]");
    expect(redactDiagnosticText(`tokens ${githubToken} ${fineGrainedToken}`)).toBe("tokens [redacted-token] [redacted-token]");
  });

  it("redacts provider-prefixed environment credentials", () => {
    const input = "OPENAI_API_KEY=plain-secret GITHUB_TOKEN=another-secret AWS_SECRET_ACCESS_KEY=aws-secret";
    expect(redactDiagnosticText(input)).toBe("OPENAI_API_KEY=[redacted] GITHUB_TOKEN=[redacted] AWS_SECRET_ACCESS_KEY=[redacted]");
  });

  it("does not redact ordinary security prose", () => {
    const prose = "Token usage is 46%. Authorization failed, so request a password reset. Read the Secret Garden notes. monkey=banana";
    expect(redactDiagnosticText(prose)).toBe(prose);
  });

  it("redacts absolute paths from historical errors without a current path inventory", () => {
    const error = [
      'Windows "Q:\\Retired Kimi\\bin\\kimi.exe"',
      "unquoted Q:\\Retired Kimi\\state\\session data.json",
      "single directory Q:\\RetiredRuntime",
      "UNC '\\\\archive-host\\Retired Kimi Data\\logs\\failure report.log'",
      "unquoted \\\\archive-host\\Retired Kimi Data\\logs\\failure report.log",
      "POSIX '/opt/Retired Kimi/runtime/config.json'",
      "unquoted /opt/Retired Kimi/runtime/config.json",
      "URL 'file:///Q:/FixtureProfiles/FormerUser/Kimi Data/config.json'",
      "unquoted file:///Q:/FixtureProfiles/FormerUser/Kimi Data/config.json",
      "retry later",
    ].join("; ");
    const redacted = redactPrivateErrorText(error);
    expect(redacted).toContain("retry later");
    expect(redacted).not.toMatch(/Retired Kimi|RetiredRuntime|Former User|archive-host/i);
    expect(redacted.match(/\[private-path\]/g)).toHaveLength(9);
  });

  it("preserves ordinary prose, web URLs, drive labels, and slash commands", () => {
    const prose = 'Use "/usage command" to inspect quota. Read https://example.com/docs/getting-started. C: is a drive label, and C:\\ is a drive root label. The API route /api/v1 remains public.';
    expect(redactPrivateErrorText(prose)).toBe(prose);
  });

  it("redacts errors immediately and re-redacts export-only paths", async () => {
    const workspace = "D:\\clients\\private-workspace";
    const journal = new DiagnosticJournal();
    const slashWorkspace = workspace.replaceAll("\\", "/");
    const wslWorkspace = "/mnt/d/clients/private-workspace";
    const record = journal.record("error", `Failed in ${workspace}, file:///${slashWorkspace}, and ${wslWorkspace}`, workspace);
    expect(record.message).toContain("[private-path]");
    expect(record.message).not.toContain(workspace);

    const directory = await mkdtemp(join(tmpdir(), "kimi-diagnostics-export-"));
    const path = await journal.export(directory, { workspace }, [workspace]);
    const contents = await readFile(path, "utf8");

    expect(contents).toContain("[home]");
    expect(contents).not.toContain(workspace);
    expect(contents).not.toContain(slashWorkspace);
    expect(contents).not.toContain(wslWorkspace);
  });
});
