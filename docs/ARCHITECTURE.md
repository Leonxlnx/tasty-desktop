# Architecture

Tasty is a local Windows control panel for Kimi Code CLI, OpenAI Codex CLI, Anthropic Claude Code, and Cursor Agent CLI. The desktop app owns presentation, durable local projection, and operating-system integrations. Each installed provider runtime remains authoritative for agent behavior, authentication, models, and account-backed capabilities.

## Components

### Tauri shell

`apps/desktop` owns the native window, folder dialogs, application lifecycle, bundled resources, update installation, and launch of the local orchestration process.

Release builds bundle the Node.js runtime and generated server entrypoint. Tauri selects a free loopback port, creates a random per-launch connection token, launches the server, and terminates its full Windows process tree with the window. Recovery preserves a healthy sidecar by default; an explicit forced recovery terminates the old tree before starting a replacement.

### React projection

`apps/web` renders state received from the orchestration server. It does not read provider credentials, execute Git, spawn terminal processes, or call provider network APIs.

The renderer reconnects and requests a durable projection after a restart. Liveness-critical reads, session reattachment, and configuration calls have bounded waits; a late configuration effect still reconciles from durable events. Other side-effecting requests are not given a client timeout that could falsely report failure. Streaming chunks are presented under the turn that produced them and are compacted after completion.

### Orchestration server

`apps/server` owns:

- ACP, Codex app-server, and Claude stream-json sessions
- Provider detection, authentication delegation, and runtime configuration
- Durable events and thread projections
- Authentication delegation
- Prompt queueing, steering, and cancellation
- Finite background-task monitoring and follow-up dispatch
- Skill discovery and confirmed workspace-local installation
- Workspace-bound file and image context
- Git checkpoints and Git manager operations
- Local terminal processes
- Kimi usage probing
- Localhost preview control and screenshot capture

The server communicates with the renderer over a loopback WebSocket. Development accepts only the configured Vite origin. Packaged builds additionally require the random launch token provided by the Tauri shell.

## Provider ownership boundary

Tasty normalizes four local transports behind one runtime interface:

- Kimi through Agent Client Protocol
- OpenAI Codex through the official Codex app server
- Anthropic Claude through Claude Code streaming JSON
- Cursor through Agent Client Protocol

Threads persist their provider and cannot switch providers after creation. Authentication commands run through the matching CLI, and credentials remain in that CLI's account store. See [Provider runtimes](PROVIDERS.md) for the exact command and feature matrix.

Kimi Code CLI is additionally the source of truth for its subscription quota, skills, plugins, MCP configuration, and native agent shortcuts.

Kimi Code CLI is the source of truth for:

- Account authentication and OAuth refresh
- Models and reasoning levels
- Permission modes and approvals
- Sessions and agent execution
- Commands, skills, subagents, and tools
- MCP behavior and Kimi configuration
- Subscription quota

The desktop app projects the runtime catalog returned by each adapter. ACP and Codex options remain runtime-driven. The Claude adapter exposes only values accepted by its current CLI command line. Tasty rejects unsupported values instead of simulating controls.

Skills are discovered from Kimi and Agents user directories plus their project-local equivalents. The built-in `coder`, `explore`, and `plan` actions are prompt shortcuts; the running-agent projection itself is built only from real Kimi `Agent` tool and background-task events.

Only MCP definitions from Kimi's trusted user store are translated into ACP session definitions. Project `.mcp.json` and `.kimi-code/mcp.json` files are discovered as redacted, review-only metadata and are never attached automatically when a repository opens. Raw URLs, headers, environment values, and arguments stay server-side.

## Durable state

Thread activity is stored as validated JSONL events under the current user's app-data directory.

- Events are written before WebSocket publication.
- Sequence numbers remain monotonic.
- Replay streams from disk without retaining the raw log in memory.
- Adjacent runtime chunks are coalesced.
- Completed history is atomically replaced with bounded thread snapshots.
- Queue state is stored separately and contains text only.
- Background-task registration, terminal status, and report-queued state are part of the thread projection.

When Kimi emits a finite task with `automatic_notification: true`, the server monitors its same-session task record. A terminal state first enters the durable FIFO and then records that the report was queued. On restart, unfinished registration and queue state are replayed and reconciled. This provides crash-recoverable at-least-once follow-up; it does not promise exactly-once delivery to an external model or process.

This design keeps the local stack small while there is a single writer. A database becomes useful only if concurrent writers or indexed history queries become real requirements.

## Workspace safety

File resources must resolve inside the active workspace, must be text, and must stay below configured size limits. Images are sent as ACP image blocks and are not stored in the persistent prompt queue.

ACP writes remain workspace-only. Background monitoring has one narrow Kimi-owned read exception: the active session may inspect its own bounded task record and `output.log` beneath the Kimi session store. Canonical path checks reject traversal, symlink escapes, other session IDs, oversized records, and every other out-of-workspace file.

Local skill installation accepts only a regular Markdown file or a directory containing `SKILL.md` inside the active workspace. Each ACP session receives a built-in `skill_install_local` MCP tool bound by the server to that session's canonical workspace. The tool accepts only an absolute local source path; it has no URL, download, overwrite, update, or uninstall mode. It never installs directly: the isolated preview bridge sends a request to normal app windows, the renderer opens the existing confirmation dialog, and only explicit user confirmation calls the installer. That call revalidates symlinks, names, path containment, size, depth, and entry counts before staging the copy in the Kimi skills directory. Existing skills are never overwritten.

Git checkpoints use an alternate `GIT_INDEX_FILE`, `git write-tree`, and `git commit-tree`. They do not modify the user's branch or index. Revert applies the reverse diff for one turn so work that existed before the turn remains intact.

Git manager mutations validate each path against live status before staging or unstaging. Destructive discard and reset operations are not exposed.

## Preview safety

The embedded preview accepts HTTP or HTTPS only when the hostname is exactly `localhost` or `127.0.0.1`.

Agent screenshot capture uses a fresh temporary Microsoft Edge profile and deletes it after capture. The preview bridge requires its own random token and is not exposed to remote pages.

## Updates

Tagged builds run on GitHub Actions with protected Tauri signing secrets. The workflow publishes:

- A Windows NSIS installer
- A Tauri updater signature
- `latest.json`
- SHA-256 checksums

The static update feed is deployed to GitHub Pages. Tauri verifies the updater signature before installation. Microsoft Authenticode is a separate signing layer and is not currently configured.

## Data flow

```text
React UI
  <-> token-protected loopback WebSocket
Node orchestration server
  <-> ACP | Codex app-server | Claude stream-json
Installed provider CLI
  <-> provider account and runtime services
```

Native Git, terminal, files, and preview operations stay on the local Windows machine.

## Upgrade compatibility

Tasty keeps the legacy `com.kimicode.desktop` application identifier, single-instance mutex, and browser preference key during the 0.10 rebrand. These internal anchors preserve existing settings, local threads, updater identity, and mutual exclusion with 0.9. Product names, package scopes, server identity, artifacts, and documentation use Tasty.
