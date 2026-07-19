# Architecture

Kimi Code Desktop is a local Windows harness around Kimi Code CLI. The desktop app owns presentation, durable local projection, and operating-system integrations. Kimi Code CLI remains authoritative for agent behavior and account-backed capabilities.

## Components

### Tauri shell

`apps/desktop` owns the native window, folder dialogs, application lifecycle, bundled resources, update installation, and launch of the local orchestration process.

Release builds bundle the Node.js runtime and generated server entrypoint. Tauri selects a free loopback port, creates a random per-launch connection token, launches the server, and terminates it with the window.

### React projection

`apps/web` renders state received from the orchestration server. It does not read Kimi credentials, execute Git, spawn terminal processes, or call Kimi network APIs.

The renderer reconnects and requests a durable projection after a restart. Streaming chunks are presented under the turn that produced them and are compacted after completion.

### Orchestration server

`apps/server` owns:

- ACP sessions and runtime configuration
- Durable events and thread projections
- Authentication delegation
- Prompt queueing, steering, and cancellation
- Workspace-bound file and image context
- Git checkpoints and Git manager operations
- Local terminal processes
- Kimi usage probing
- Localhost preview control and screenshot capture

The server communicates with the renderer over a loopback WebSocket. Development accepts only the configured Vite origin. Packaged builds additionally require the random launch token provided by the Tauri shell.

## Kimi ownership boundary

Kimi Code CLI is the source of truth for:

- Account authentication and OAuth refresh
- Models and reasoning levels
- Permission modes and approvals
- Sessions and agent execution
- Commands, skills, subagents, and tools
- MCP behavior and Kimi configuration
- Subscription quota

The desktop app projects the runtime catalog returned by ACP. It rejects unsupported values instead of simulating controls.

MCP definitions are read from Kimi's standard local store and translated into ACP session definitions. Raw URLs, headers, environment values, and arguments stay server-side. The renderer receives only redacted capability metadata.

## Durable state

Thread activity is stored as validated JSONL events under the current user's app-data directory.

- Events are written before WebSocket publication.
- Sequence numbers remain monotonic.
- Replay streams from disk without retaining the raw log in memory.
- Adjacent runtime chunks are coalesced.
- Completed history is atomically replaced with bounded thread snapshots.
- Queue state is stored separately and contains text only.

This design keeps the local stack small while there is a single writer. A database becomes useful only if concurrent writers or indexed history queries become real requirements.

## Workspace safety

File resources must resolve inside the active workspace, must be text, and must stay below configured size limits. Images are sent as ACP image blocks and are not stored in the persistent prompt queue.

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
  <-> Agent Client Protocol
Installed Kimi Code CLI
  <-> Kimi account and runtime services
```

Native Git, terminal, files, and preview operations stay on the local Windows machine.
