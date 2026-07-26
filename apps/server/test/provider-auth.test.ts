import { describe, expect, it } from "vitest";
import { parseProviderAuthStatus } from "../src/provider-auth.js";

describe("provider authentication status", () => {
  it("parses Codex, Claude, and Cursor without treating unknown state as signed out", () => {
    expect(parseProviderAuthStatus("codex", { code: 0, stdout: "Logged in using ChatGPT", stderr: "", timedOut: false }).authenticated).toBe(true);
    expect(parseProviderAuthStatus("claude", { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "dev@example.com" }), stderr: "", timedOut: false })).toMatchObject({ authenticated: true, account: "dev@example.com" });
    expect(parseProviderAuthStatus("cursor", { code: 0, stdout: JSON.stringify({ cliVersion: "1", userEmail: null }), stderr: "", timedOut: false }).authenticated).toBe(false);
    expect(parseProviderAuthStatus("claude", { code: null, stdout: "", stderr: "", timedOut: true }).authenticated).toBeNull();
  });
});
