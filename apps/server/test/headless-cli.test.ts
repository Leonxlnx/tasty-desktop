import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCredentials, normalizeRemoteEndpoint, parseCli, saveCredentials } from "../src/headless-cli.js";

describe("headless CLI", () => {
  it("parses remote commands without putting credentials in URLs", () => {
    expect(parseCli(["send", "thread-1", "fix", "the", "tests"])).toEqual({ name: "send", threadId: "thread-1", text: "fix the tests" });
    expect(parseCli(["watch", "thread-1"])).toEqual({ name: "watch", threadId: "thread-1" });
    expect(normalizeRemoteEndpoint("wss://tasty.example/remote")).toBe("wss://tasty.example");
    expect(() => normalizeRemoteEndpoint("ws://user:secret@host:4318?token=bad")).toThrow("plain ws:// or wss://");
    expect(parseCli(["pair", "ws://host:4318", "ABCD-EFGH"])).toMatchObject({ deviceName: "Kimi Code headless CLI" });
  });

  it("prefers Kimi credentials and reads legacy credentials only as a fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-headless-"));
    const current = join(directory, ".kimi-code-desktop", "headless.json");
    const legacy = join(directory, ".tasty", "headless.json");
    const oldCredentials = { endpoint: "ws://legacy:4318", token: "legacy-device-token-123456", deviceName: "Legacy device" };
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify(oldCredentials), "utf8");
    expect(await loadCredentials(directory, {})).toEqual(oldCredentials);

    const currentCredentials = { endpoint: "ws://current:4318", token: "current-device-token-123456", deviceName: "Kimi device" };
    await saveCredentials(currentCredentials, directory);
    expect(await loadCredentials(directory, {})).toEqual(currentCredentials);
    expect(JSON.parse(await readFile(current, "utf8"))).toEqual(currentCredentials);

    await writeFile(current, "not json", "utf8");
    await expect(loadCredentials(directory, {})).rejects.toBeInstanceOf(SyntaxError);
  });

  it("prefers Kimi environment credentials and keeps the legacy pair as a fallback", async () => {
    const environment: NodeJS.ProcessEnv = {
      KIMI_DESKTOP_REMOTE_URL: "wss://kimi.example/remote",
      KIMI_DESKTOP_REMOTE_TOKEN: "kimi-environment-token-123456",
      TASTY_REMOTE_URL: "wss://legacy.example/remote",
      TASTY_REMOTE_TOKEN: "legacy-environment-token-123456",
    };
    expect(await loadCredentials("unused", environment)).toMatchObject({ endpoint: "wss://kimi.example", token: environment.KIMI_DESKTOP_REMOTE_TOKEN });
    delete environment.KIMI_DESKTOP_REMOTE_URL;
    delete environment.KIMI_DESKTOP_REMOTE_TOKEN;
    expect(await loadCredentials("unused", environment)).toMatchObject({ endpoint: "wss://legacy.example", token: environment.TASTY_REMOTE_TOKEN });
  });
});
