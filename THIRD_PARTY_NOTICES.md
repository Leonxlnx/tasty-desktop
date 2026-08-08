# Third-party Notices

## Node.js

The Windows x64 installer bundles Node.js v22.22.2 for the local orchestration server. Node.js is copyright the Node.js contributors and is distributed under the terms in its combined license and third-party notices.

The shipped license is [`third_party/node/v22.22.2/LICENSE.txt`](third_party/node/v22.22.2/LICENSE.txt), copied unchanged from the official `node-v22.22.2-win-x64.zip` distribution:

- Official archive: <https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip>
- Archive SHA-256: `7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c`
- Signed tag: [`v22.22.2`](https://github.com/nodejs/node/tree/v22.22.2), commit `2645dc73720b1b4f27c49f395d3c66025ce126cc`
- Bundled `node.exe` SHA-256: `ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3`
- License Git blob: `a640a1f4708257449c53645022c8762488d7261f`
- Bundled license SHA-256: `8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576`

## Agent Client Protocol

The server uses the Agent Client Protocol TypeScript SDK from Zed Industries under the Apache License 2.0. See <https://github.com/agentclientprotocol/typescript-sdk>.

## Application dependencies

JavaScript and Rust dependencies remain under their respective licenses. Exact versions are locked in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`.

The auditable Windows distribution inventory is generated from the installed production JavaScript graph and the locked Windows Rust graph. It is stored in [`third_party/licenses/inventory.json`](third_party/licenses/inventory.json), with every locally available license or notice file copied byte-for-byte into `third_party/licenses/texts/` and identified by SHA-256. The same files are included in the installer under `third-party-licenses/`.

Run `corepack pnpm@10.13.1 check:licenses` before a release. The check fails when the graph changes, a copied text changes, license metadata is absent, or an upstream package omits license evidence that has not been reviewed. Regenerate with `corepack pnpm@10.13.1 licenses:write`, inspect the complete diff, and never infer a copyright notice from package authors.

## Kimi Code CLI

Kimi Code CLI is not bundled. When it is missing, the app can open Kimi's official installation guide after a user action. Kimi Code CLI remains subject to its own license and terms.

## Kimi names and marks

This repository uses Kimi names and artwork to identify interoperability with Kimi Code CLI. Kimi, Kimi Code, Moonshot AI, and their names, logos, and marks belong to their respective owners and are not included in this repository's MIT License.

This community project is not affiliated with, endorsed by, or supported by Moonshot AI. Forks and redistributed builds are responsible for reviewing their branding and must remain clearly unofficial.
