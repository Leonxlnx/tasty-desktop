import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DiagnosticJournal, redactDiagnosticText } from "../src/diagnostics.js";

describe("diagnostic support bundles", () => {
  it("bounds and redacts secrets and local home paths", async () => {
    const home = "C:\\Users\\private";
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
    expect(redactDiagnosticText("https://host.test/path?token=top-secret&ok=1")).toContain("token=[redacted]");
  });
});
