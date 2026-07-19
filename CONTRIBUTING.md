# Contributing

Kimi Code Desktop is a Windows-first community client for the official Kimi Code CLI.

Contributions should preserve the user's normal Kimi account, home, sessions, and configuration. Never add an app-owned credential store or move Kimi-owned behavior into a competing desktop implementation.

## Before you start

- Search existing issues before opening a new one.
- Use an issue for changes that alter product scope, security boundaries, persistence, or release behavior.
- Keep each pull request focused on one clear outcome.
- Do not commit credentials, account data, local work logs, private paths, third-party screenshots, or research documents without redistribution permission.

Read the [Architecture](docs/ARCHITECTURE.md), [Design System](docs/DESIGN.md), and [Security Policy](SECURITY.md) before changing a trust boundary or interface pattern.

## Local setup

Requirements:

- Windows 10 or Windows 11
- Node.js 22 or newer
- pnpm 10
- Rust and Cargo
- WebView2

Install dependencies and run with the deterministic fake runtime:

```powershell
pnpm install --frozen-lockfile
$env:KIMI_FAKE='1'
pnpm dev
```

The fake runtime covers streaming thought, plans, tool activity, approvals, configuration, cancellation, and final responses without an account.

## Development rules

- Prefer focused fixes in existing modules over new abstractions or dependencies.
- Keep the renderer projection-only.
- Preserve workspace path validation, credential redaction, loopback origin checks, and update signing.
- Keep model, reasoning, permission, command, skill, MCP, and subagent options runtime-driven.
- Respect keyboard access, visible focus, reduced motion, and user typography settings.
- Do not add destructive Git reset or discard actions.
- Use ASCII hyphens in Markdown documentation.

## Validation

Run before opening a pull request:

```powershell
pnpm typecheck
pnpm test
pnpm build:services
git diff --check
```

Run `pnpm bundle:local` only when a native installer is required for local testing. Published builds must come from the signed tag workflow.

## Pull requests

A pull request should explain:

- What changed
- Why the change is needed
- User and contributor impact
- Root cause for a bug fix
- Validation performed

Include sanitized screenshots only when the interface changed. Remove account details, private paths, tokens, and project content.

By contributing, you agree that your contribution is licensed under the repository's MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
