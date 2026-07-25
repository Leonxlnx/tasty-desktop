# Third-party Notices

## Node.js

The Windows x64 installer bundles Node.js v22.22.2 for the local orchestration server. Node.js is copyright the Node.js contributors and is distributed under the terms in its combined license and third-party notices.

The exact file shipped beside `node.exe` is [`third_party/node/v22.22.2/LICENSE.txt`](third_party/node/v22.22.2/LICENSE.txt), copied unchanged from the official `node-v22.22.2-win-x64.zip` distribution:

- Official archive: <https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip>
- Archive SHA-256 from the official `SHASUMS256.txt`: `7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c`
- Signed Node.js tag: [`v22.22.2`](https://github.com/nodejs/node/tree/v22.22.2), commit `2645dc73720b1b4f27c49f395d3c66025ce126cc`
- Bundled `node.exe` SHA-256: `ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3`
- License Git blob: `a640a1f4708257449c53645022c8762488d7261f`
- Bundled license SHA-256: `8cc9bb466b19fc7e7cc99d03e9df1132021fda8b01eea2624c58bb372dbef576`

## Agent Client Protocol

The server uses the Agent Client Protocol TypeScript SDK from Zed Industries under the Apache License 2.0. See <https://github.com/agentclientprotocol/typescript-sdk>.

## Application dependencies

Runtime JavaScript and Rust dependencies remain under their respective licenses. Exact versions are locked in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`.

## Kimi Code CLI

Kimi Code CLI is not bundled. Optional onboarding downloads its installer from Kimi's official `https://code.kimi.com/install.ps1` endpoint. Kimi Code CLI remains subject to its own license and terms.

## Kimi names and marks

The repository contains Kimi names and logo assets only to identify interoperability with Kimi Code CLI and the application the project connects to.

Kimi, Moonshot AI, and their names, logos, and marks belong to their respective owners. They are not included in this repository's MIT License. Their presence does not grant trademark rights or imply affiliation, endorsement, or support.

Forks and redistributed builds are responsible for reviewing their branding and must remain clearly unofficial.
