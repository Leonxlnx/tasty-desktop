import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

export type WslDistribution = { name: string; system: boolean; healthy: boolean; message?: string };

export class WslEnvironments {
  readonly binary = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe") : "wsl";

  async list(): Promise<WslDistribution[]> {
    if (process.platform !== "win32") return [];
    const listed = await run(this.binary, ["--list", "--quiet"], 5_000);
    if (listed.code !== 0) return [];
    const names = [...new Set(decode(listed.stdout).split(/\r?\n/).map((name) => name.replaceAll("\0", "").trim()).filter(Boolean))];
    return Promise.all(names.map(async (name) => {
      const system = /^(?:docker-desktop|docker-desktop-data)$/i.test(name);
      if (system) return { name, system, healthy: false, message: "System distribution" };
      const health = await run(this.binary, ["--distribution", name, "--exec", "sh", "-lc", "printf KIMI_WSL_OK"], 8_000);
      return { name, system, healthy: health.code === 0 && decode(health.stdout).includes("KIMI_WSL_OK"), ...(health.code === 0 ? {} : { message: bounded(decode(health.stderr) || "Health check failed") }) };
    }));
  }

  async toLinux(distribution: string, windowsPath: string): Promise<string> {
    if (!isAbsolute(windowsPath)) throw new Error("WSL path translation requires an absolute Windows path");
    await this.requireHealthy(distribution);
    const result = await run(this.binary, ["--distribution", distribution, "--exec", "wslpath", "-a", "-u", windowsPath], 8_000);
    const path = decode(result.stdout).trim();
    if (result.code !== 0 || !path.startsWith("/")) throw new Error(bounded(decode(result.stderr) || "WSL path translation failed"));
    return path;
  }

  async toWindows(distribution: string, linuxPath: string): Promise<string> {
    if (!linuxPath.startsWith("/")) throw new Error("WSL path translation requires an absolute Linux path");
    const result = await run(this.binary, ["--distribution", distribution, "--exec", "wslpath", "-a", "-w", linuxPath], 8_000);
    const path = decode(result.stdout).trim();
    if (result.code !== 0 || !isAbsolute(path)) throw new Error(bounded(decode(result.stderr) || "WSL path translation failed"));
    return path;
  }

  private async requireHealthy(distribution: string): Promise<void> {
    const available = await this.list();
    const selected = available.find((item) => item.name === distribution);
    if (!selected?.healthy) throw new Error(`WSL distribution ${distribution} is not available for agent work`);
  }
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => stderr.push(Buffer.from(error.message)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
  });
}

export function decode(buffer: Buffer): string {
  return buffer.includes(0) ? buffer.toString("utf16le").replace(/^\uFEFF/, "") : buffer.toString("utf8");
}

function bounded(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}
