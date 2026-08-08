# Contributing

Kimi Code Desktop is a Windows-first community harness for Kimi Code CLI.

Contributions must preserve Kimi Code CLI as the source of truth for authentication, sessions, models, permissions, commands, skills, MCP, plugins, subagents, and quota. Never add an app-owned credential store or duplicate Kimi-owned behavior in the desktop layer.

## Before you start

- Search existing issues before opening a new one.
- Use an issue for changes to product scope, security boundaries, persistence, or release behavior.
- Keep each pull request focused on one clear outcome.
- Do not commit credentials, account data, local work logs, private paths, third-party screenshots, or research material without redistribution permission.

Read the [Architecture](docs/ARCHITECTURE.md), [Design System](docs/DESIGN.md), and [Security Policy](SECURITY.md) before changing a trust boundary or interface pattern.

## Local setup

Requirements:

- Windows 10 or Windows 11
- Node.js 22 or newer
- pnpm 10
- Rust and Cargo
- Microsoft WebView2

Install dependencies and run with the deterministic fake Kimi runtime:

```powershell
corepack pnpm@10.13.1 install --frozen-lockfile
$env:KIMI_FAKE='1'
corepack pnpm@10.13.1 dev
```

The fake runtime covers streaming thought, plans, tool activity, approvals, configuration, cancellation, and final responses without an account.

## Development rules

- Prefer focused fixes in existing modules over new abstractions or dependencies.
- Keep the renderer projection-only.
- Preserve workspace path validation, credential redaction, loopback origin checks, and update signing.
- Keep models, reasoning, permissions, commands, skills, MCP, and subagents runtime-driven.
- Keep discontinued runtime history readable but read-only.
- Respect keyboard access, visible focus, reduced motion, and user typography settings.
- Do not add destructive Git reset or broad discard actions.
- Use ASCII hyphens in Markdown documentation.

## Validation

Run before opening a pull request:

```powershell
corepack pnpm@10.13.1 check:public
corepack pnpm@10.13.1 typecheck
corepack pnpm@10.13.1 test
corepack pnpm@10.13.1 build:services
git diff --check
```

Run `corepack pnpm@10.13.1 bundle:local` only when a native installer is needed for local testing. Published builds must come from the signed tag workflow.

## Pull requests

A pull request should explain:

- What changed
- Why the change is needed
- User and contributor impact
- Root cause for a bug fix
- Validation performed

Include sanitized screenshots only when the interface changed. Remove account details, private paths, tokens, and project content.

By contributing, you agree that your contribution is licensed under the repository's MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
