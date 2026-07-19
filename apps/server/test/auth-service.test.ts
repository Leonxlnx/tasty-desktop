import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AuthService, clearKimiCredentials, hasKimiCredentials, parseLoginLine } from "../src/auth-service.js";

describe("AuthService", () => {
  it("extracts device pairing URLs and codes without reading credentials", () => {
    expect(parseLoginLine("Visit https://auth.kimi.com/device and enter code ABCD-EFGH")).toEqual({
      message: "Visit https://auth.kimi.com/device and enter code ABCD-EFGH",
      url: "https://auth.kimi.com/device",
      code: "ABCD-EFGH",
    });
  });

  it("detects credential presence only from filesystem metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-auth-"));
    expect(hasKimiCredentials(home)).toBe(false);
    await mkdir(join(home, "credentials"));
    await writeFile(join(home, "credentials", "kimi-code.json"), "secret");
    await writeFile(join(home, "credentials", "mcp-auth.json"), "keep me");
    expect(hasKimiCredentials(home)).toBe(true);
    expect(new AuthService("kimi", home, () => undefined).status()).toMatchObject({ installed: false, authenticated: true, loginRunning: false });
    clearKimiCredentials(home);
    expect(hasKimiCredentials(home)).toBe(false);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(join(home, "credentials", "mcp-auth.json"), "utf8"))).toBe("keep me");
  });
});
