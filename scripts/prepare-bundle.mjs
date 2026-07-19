import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps", "desktop", "src-tauri", "target", "bundle-assets");
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(process.execPath, join(output, "node.exe")),
  copyFile(join(root, "LICENSE"), join(output, "LICENSE.txt")),
  copyFile(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md")),
]);
