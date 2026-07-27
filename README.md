# Tasty

Tasty is an open-source desktop control panel for local coding agents. It brings Kimi, OpenAI Codex, Anthropic Claude, Cursor, and OpenCode into one project-aware workspace without moving provider credentials into the app.

> [!IMPORTANT]
> Tasty is a community project. It is not affiliated with or endorsed by Moonshot AI, OpenAI, Anthropic, Cursor, or OpenCode.

## Download

Download the latest signed Windows build from [GitHub Releases](https://github.com/Leonxlnx/tasty-desktop/releases/latest).

Current source version: `0.11.1`

Requirements:

- Windows 10 or Windows 11
- Microsoft WebView2
- At least one supported provider CLI and account

The installer includes the local Node.js runtime used by Tasty. End users do not need Node.js, pnpm, or Rust.

## Providers

| Provider | Local runtime | Session transport | Sign-in owner |
| --- | --- | --- | --- |
| Kimi | Kimi Code CLI | Agent Client Protocol | Kimi Code CLI |
| OpenAI Codex | Codex CLI | Codex app server | Codex CLI |
| Anthropic Claude | Claude Code CLI | Streaming JSON | Claude Code CLI |
| Cursor | Cursor Agent CLI | Agent Client Protocol | Cursor Agent CLI |
| OpenCode | OpenCode CLI | Agent Client Protocol | OpenCode CLI |

Tasty detects installed CLIs, opens each provider's official installation guide when one is missing, and delegates sign-in and sign-out to that CLI. Passwords, API keys, OAuth tokens, and provider session stores never enter Tasty preferences.

See [Provider runtimes](docs/PROVIDERS.md) for supported behavior and current limitations.

## What it does

- Opens local projects with multiple resumable chats per folder
- Can create an explicit isolated Git worktree and branch for a project chat
- Keeps standalone chats separate from project files and Git state
- Creates goal-backed work with `/goal <objective>` and clears it with `/goal clear`
- Creates nested side chats with `/side [title]`
- Streams Markdown answers and plain-language progress while keeping commands and tool output compact and collapsible
- Queues prompts with Enter and steers active work with Ctrl+Enter
- Supports stop, edit and retry, copy, revert, rename, archive, restore, remove, and delete workflows
- Shows runtime-provided models, reasoning effort, permissions, context, and Kimi quota without inventing unavailable controls
- Projects subagent activity into an Agents panel, opens linked Codex transcripts, and stops an individual Codex subagent when its runtime turn is active
- Includes Git branches, changes, commits, push/pull, clone, GitHub publish/PR handoff, turn-level file/hunk review with feedback and safe partial revert, persistent terminal tabs and splits, file inspection, and an agent-controlled localhost preview panel
- Includes a global command palette for actions, chats, projects, safe package scripts, and editor handoff
- Shows a truthful provider capability matrix, stores provider-bound agent profiles, and discovers Kimi-owned skills, plugins, MCP servers, and agent shortcuts
- Persists a compact local event projection for crash recovery and long sessions
- Schedules explicit tasks in existing chats, provides a paired headless CLI, and exports redacted private chat archives
- Supports configurable theme, typography, density, panel placement, and panel sizing
- Uses signed in-app updates with an explicit install and restart action

## Getting started

1. Install and open Tasty.
2. Choose a provider during onboarding.
3. Install its official CLI if Tasty reports that it is missing.
4. Sign in through the provider CLI flow.
5. Open a folder for project work or start a standalone chat.

Existing pre-rebrand 0.9 installations upgrade in place. Tasty keeps the required internal compatibility keys so existing settings, chats, and updater trust continue to work.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl+K` |
| New chat | `Ctrl+N` |
| Toggle sidebar | `Ctrl+B` |
| Open terminal | `Ctrl+J` |
| Open Settings | `Ctrl+,` |
| Send or queue | `Enter` |
| Steer active work | `Ctrl+Enter` |
| Insert line break | `Shift+Enter` |

Global shortcuts, the idle send shortcut, and the external editor can be changed in General settings. Conflicting global shortcuts are disabled until resolved.

## Privacy and security

- The primary orchestration service binds only to `127.0.0.1`. Optional remote access uses a separate, disabled-by-default listener with one-time pairing and revocable device tokens.
- Packaged renderer connections require a random per-launch token.
- Provider credentials stay in each official CLI's own account store.
- File access is workspace-bound, text-only, and size-limited.
- Local skill installation accepts only validated files inside the active workspace and requires confirmation.
- App preview accepts only `localhost` and `127.0.0.1` URLs.
- Preview screenshots use an isolated temporary Edge profile, never the user's normal browser profile.
- Tasty has no application telemetry.
- Redacted support bundles are written locally only after an explicit export action.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Development

Contributor requirements:

- Node.js 22 or newer
- pnpm 10
- Rust and Cargo
- Microsoft WebView2
- One provider CLI, or the deterministic fake ACP runtime

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Use the fake runtime without a provider account:

```powershell
$env:KIMI_FAKE='1'
pnpm dev
```

Verify a change:

```powershell
pnpm check:public
pnpm typecheck
pnpm test
pnpm build:services
git diff --check
```

Create an unsigned local installer:

```powershell
pnpm bundle:local
```

Published installers must be produced by the tagged GitHub Actions workflow. It creates the installer, updater signature, update manifest, and SHA-256 checksums with protected signing secrets.

## Repository

This pnpm monorepo contains:

- `apps/desktop`: Tauri v2 shell and Windows integration
- `apps/web`: React UI and durable event projection
- `apps/server`: provider runtimes, orchestration, Git, terminal, preview, and updates

Documentation:

- [User guide](docs/USER_GUIDE.md)
- [Provider runtimes](docs/PROVIDERS.md)
- [Private remote access](docs/REMOTE_ACCESS.md)
- [Automation, headless control, and private exports](docs/AUTOMATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Design system](docs/DESIGN.md)
- [T3 Code research notes](docs/T3_CODE_RESEARCH.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release process](docs/RELEASING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License and trademarks

Source code is licensed under the [MIT License](LICENSE).

Kimi, Moonshot AI, OpenAI, Codex, Anthropic, Claude, Cursor, and their names, logos, and marks belong to their respective owners. They are not covered by the MIT license. Forks and redistributed builds must remain clearly unofficial.
