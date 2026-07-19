import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const ignored = new Set([".git", "node_modules", "dist", "build", "target", ".turbo"]);

export async function listWorkspaceFiles(cwd: string, query = "", limit = 500): Promise<string[]> {
  const root = resolve(cwd);
  if (!isAbsolute(root)) throw new Error("Workspace path must be absolute");
  const files: string[] = [];
  const queue = [root];
  const needle = query.toLowerCase();
  while (queue.length && files.length < limit) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) {
        const rel = relative(root, path).replaceAll("\\", "/");
        if (!needle || rel.toLowerCase().includes(needle)) files.push(rel);
        if (files.length >= limit) break;
      }
    }
  }
  return files.sort();
}

export async function readWorkspaceFile(cwd: string, path: string): Promise<{ path: string; content: string }> {
  const safe = workspacePath(cwd, path);
  const info = await stat(safe);
  if (!info.isFile()) throw new Error("Path is not a file");
  if (info.size > 1_000_000) throw new Error("Text resources are limited to 1 MB");
  return { path: safe, content: await readFile(safe, "utf8") };
}

export function workspacePath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const safe = resolve(isAbsolute(path) ? path : join(root, path));
  const rel = relative(root, safe);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside workspace: ${safe}`);
  return safe;
}
