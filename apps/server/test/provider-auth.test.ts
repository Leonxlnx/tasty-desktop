import { describe, expect, it } from "vitest";
import { parseProviderAuthStatus } from "../src/provider-auth.js";

describe("provider authentication status", () => {
  it("parses provider-owned authentication without treating unknown state as signed out", () => {
    expect(parseProviderAuthStatus("codex", { code: 0, stdout: "Logged in using ChatGPT", stderr: "", timedOut: false }).authenticated).toBe(true);
    expect(parseProviderAuthStatus("claude", { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "dev@example.com" }), stderr: "", timedOut: false })).toMatchObject({ authenticated: true, account: "dev@example.com" });
    expect(parseProviderAuthStatus("cursor", { code: 0, stdout: JSON.stringify({ cliVersion: "1", userEmail: null }), stderr: "", timedOut: false }).authenticated).toBe(false);
    expect(parseProviderAuthStatus("opencode", { code: 0, stdout: "Credentials C:\\auth.json\n2 credentials", stderr: "", timedOut: false }).authenticated).toBe(true);
    expect(parseProviderAuthStatus("opencode", { code: 0, stdout: "0 credentials", stderr: "", timedOut: false }).authenticated).toBeNull();
    expect(parseProviderAuthStatus("claude", { code: null, stdout: "", stderr: "", timedOut: true }).authenticated).toBeNull();
  });
});
