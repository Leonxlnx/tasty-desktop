import { describe, expect, it } from "vitest";
import { decode } from "../src/wsl-environments.js";

describe("WSL environment protocol", () => {
  it("decodes the UTF-16 output emitted by wsl.exe", () => {
    expect(decode(Buffer.from("Ubuntu\r\n", "utf16le"))).toBe("Ubuntu\r\n");
    expect(decode(Buffer.from("TASTY_WSL_OK", "utf8"))).toBe("TASTY_WSL_OK");
  });
});
