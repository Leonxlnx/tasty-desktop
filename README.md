# Kimi Code Desktop

An unofficial, open-source Windows desktop client and agent harness for [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli).

Sign in with your own Kimi account, use your own plan and quota, open local projects, and run Kimi coding sessions through a native desktop interface.

> [!IMPORTANT]
> Kimi Code Desktop is a community project. It is not affiliated with, endorsed by, or supported by Moonshot AI.

## Download

Download the latest signed updater build from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest).

Current version: `0.8.3`

Requirements:

- Windows 10 or Windows 11
- Microsoft WebView2
- A Kimi account with access to Kimi Code

The installer includes the local Node.js runtime used by the desktop orchestration service. End users do not need Node.js, pnpm, or Rust.

## Getting started

1. Install and open Kimi Code Desktop.
2. Complete onboarding. The app checks for Kimi Code CLI and can run Kimi's official Windows installer if needed.
3. Select **Begin sign-in** and approve the device code with your own Kimi account.
4. Open a folder for project work or create a standalone chat.

Authentication remains owned by the official Kimi Code CLI. The desktop app does not ship an account, copy OAuth tokens, or create a second credential store.

## Highlights

- Project workspaces with multiple resumable chats per folder
- Standalone chats that stay separate from project files and Git state
- Streaming Markdown responses with collapsed thinking and tool activity
- Prompt queueing, steering, cancellation, copy, and turn revert controls
- Live Kimi model, reasoning, permission, context, and quota surfaces
- Kimi commands, skills, subagents, plugins, and MCP configuration
- Integrated Git changes, diff, stage, unstage, and commit workflows
- Workspace terminal, file preview, and agent-controlled localhost app preview
- Configurable theme, typography, density, layout, shortcuts, and panel sizes
- Signed in-app updates with explicit install and restart controls

See the [User Guide](docs/USER_GUIDE.md) for the full desktop workflow.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New chat | `Ctrl+N` |
| Toggle sidebar | `Ctrl+B` |
| Open terminal | `Ctrl+J` |
| Open Settings | `Ctrl+,` |
| Send prompt | `Enter` |
| Insert line break | `Shift+Enter` |

The send shortcut can be changed in General settings.

## Privacy and security

- The local orchestration service binds only to `127.0.0.1`.
- Packaged connections require a random per-launch token.
- Kimi credentials remain in the official Kimi CLI home and are never read by the renderer.
- File resources are workspace-bound, text-only, and size-limited.
- App preview accepts only `localhost` and `127.0.0.1` URLs.
- Preview screenshots use an isolated temporary Microsoft Edge profile, never a person's normal browser profile.
- No application telemetry is implemented.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Development

Requirements for contributors:

- Node.js 22 or newer
- pnpm 10
- Rust and Cargo
- WebView2
- Kimi Code CLI 0.26.0 or a compatible version

Install and start the native development app:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Use the deterministic fake ACP runtime when an account is not available:

```powershell
$env:KIMI_FAKE='1'
pnpm dev
```

Verify a change:

```powershell
pnpm typecheck
pnpm test
pnpm build:services
git diff --check
```

Create an unsigned local installer for development testing:

```powershell
pnpm bundle:local
```

Published installers must be built by the tagged GitHub Actions release workflow. It produces the installer, updater signature, update manifest, and SHA-256 checksums with the repository's protected signing secrets.

## Architecture

This pnpm monorepo contains three applications:

- `apps/desktop`: Tauri v2 shell and native Windows integration
- `apps/web`: React projection layer and desktop UI
- `apps/server`: ACP client, durable event projection, authentication broker, Git, terminal, preview, and update support

Kimi Code CLI remains the source of truth for models, permissions, sessions, commands, skills, subagents, MCP tools, authentication, and subscription usage. Read [Architecture](docs/ARCHITECTURE.md) for trust boundaries and data flow.

## Documentation

- [User Guide](docs/USER_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design System](docs/DESIGN.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Release Process](docs/RELEASING.md)
- [Kimi ACP Runtime Notes](docs/acp-runtime-notes.md)
- [Third-party Notices](THIRD_PARTY_NOTICES.md)

## License and trademarks

Source code is licensed under the [MIT License](LICENSE).

Kimi, Moonshot AI, and their names, logos, and marks belong to their respective owners. They are not covered by the MIT license. Forks and redistributed builds must remain clearly unofficial and must not imply endorsement.
