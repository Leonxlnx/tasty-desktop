# Kimi Code Desktop

Kimi Code Desktop is an unofficial, open-source Windows desktop harness for [Kimi Code CLI](https://www.kimi.com/code/docs/en/). It adds project navigation, durable chats, Git tools, terminal tabs, local preview, skills, subagents, schedules, and remote control while Kimi Code CLI remains the agent runtime.

> [!IMPORTANT]
> This community project is not affiliated with, endorsed by, or supported by Moonshot AI.

## Download

Download the latest Windows installer from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest).

Requirements:

- Windows 10 or Windows 11
- Microsoft WebView2
- A Kimi Code account with Kimi Code CLI access

The installer includes the Node.js runtime used by the local orchestration service. It does not bundle Kimi Code CLI or Kimi credentials.

## Highlights

- Local projects with multiple resumable chats per folder
- Standalone chats that stay separate from project files and Git state
- Streaming Markdown, compact tool activity, prompt queueing, steering, stop, edit and retry, and per-turn summaries
- Runtime-provided models, reasoning levels, permissions, context use, and Kimi plan quota
- Kimi commands, skills, MCP configuration, plugins, subagents, goals, and side chats
- Git status, diffs, staging, commits, branches, push, pull, clone, GitHub publish and pull request handoff, checkpoints, review, and safe per-turn revert
- Persistent terminal tabs and splits, workspace file preview, and agent-controlled localhost preview
- Configurable theme, typography, density, panel placement, and panel sizing, with reduced-motion support
- Optional schedules, redacted local exports, and paired private-network control
- Signed in-app updates with an explicit install and restart action

Kimi Code Desktop starts sign-in through Kimi Code CLI and keeps authentication in the Kimi credential store. Passwords, API keys, OAuth tokens, and Kimi session credentials never enter desktop preferences.

Chats created by discontinued runtime adapters remain available as read-only history. New work and resumed agent execution use Kimi Code only.

## Getting started

1. Install and open Kimi Code Desktop.
2. Install Kimi Code CLI from its official guide if it is not already available.
3. Sign in through the Kimi Code CLI flow shown by the app.
4. Open a folder for project work or start a standalone chat.

See the [User Guide](docs/USER_GUIDE.md) for projects, prompts, Git, terminal, preview, extensions, remote access, and troubleshooting.

## Shortcuts

| Action | Default |
| --- | --- |
| Command palette | `Ctrl+K` |
| New chat | `Ctrl+N` |
| Toggle sidebar | `Ctrl+B` |
| Open terminal | `Ctrl+J` |
| Open settings | `Ctrl+,` |
| Send or queue | `Enter` |
| Steer active work | `Ctrl+Enter` |
| Insert line break | `Shift+Enter` |

Global shortcuts, the idle send shortcut, and the external editor can be changed in settings. Conflicting global shortcuts remain disabled until resolved.

## Privacy and security

- The main orchestration service binds only to `127.0.0.1` and packaged renderer connections require a random per-launch token.
- Kimi credentials remain in the Kimi Code CLI account store.
- Workspace file access is path-bound, text-only, and size-limited.
- Skill installation accepts validated files from the active workspace and requires confirmation.
- Embedded preview accepts only exact `localhost` or `127.0.0.1` URLs.
- Preview screenshots use a temporary isolated Edge profile, never the user's browser profile.
- Optional remote access is disabled by default and uses one-time pairing plus revocable device tokens.
- The app has no product telemetry and never uploads support exports automatically.

Read the [Security Policy](SECURITY.md) before reporting a vulnerability.

## Development

Requirements for contributors:

- Node.js 22 or newer
- pnpm 10
- Rust and Cargo
- Microsoft WebView2

Run the app with the deterministic fake Kimi runtime:

```powershell
corepack pnpm@10.13.1 install --frozen-lockfile
$env:KIMI_FAKE='1'
corepack pnpm@10.13.1 dev
```

Verify a change:

```powershell
corepack pnpm@10.13.1 check:public
corepack pnpm@10.13.1 typecheck
corepack pnpm@10.13.1 test
corepack pnpm@10.13.1 build:services
git diff --check
```

Build an unsigned local installer:

```powershell
corepack pnpm@10.13.1 bundle:local
```

Published installers come from the tagged GitHub Actions workflow, which creates the installer, updater signature, update manifest, and checksums.

## Repository

This pnpm monorepo contains:

- `apps/desktop`: Tauri v2 shell and Windows integration
- `apps/web`: React interface for the durable server projection
- `apps/server`: Kimi ACP runtime, orchestration, Git, terminal, preview, remote access, and updates

Documentation:

- [User Guide](docs/USER_GUIDE.md)
- [Kimi Runtime](docs/PROVIDERS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design System](docs/DESIGN.md)
- [Remote Access](docs/REMOTE_ACCESS.md)
- [Automation and Exports](docs/AUTOMATION.md)
- [Contributing](CONTRIBUTING.md)
- [Release Process](docs/RELEASING.md)
- [Third-party Notices](THIRD_PARTY_NOTICES.md)

## License and trademarks

The source code is licensed under the [MIT License](LICENSE).

Kimi, Kimi Code, Moonshot AI, and their names, logos, and marks belong to their respective owners and are not covered by this repository's license. Forks and redistributed builds must remain clearly unofficial.
