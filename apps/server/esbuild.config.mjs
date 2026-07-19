import { build } from "esbuild";

await build({
  entryPoints: { server: "src/server.ts", "preview-mcp": "src/preview-mcp.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
