# Architecture

Kimi Code Desktop is a local Windows harness for Kimi Code CLI. The desktop app owns presentation, durable local projection, and operating-system integrations. Kimi Code CLI remains authoritative for agent behavior, authentication, sessions, models, permissions, and account-backed capabilities.

## Components

### Tauri shell

`apps/desktop` owns the native window, folder dialogs, application lifecycle, bundled resources, update installation, and launch of the local orchestration process.

Release builds bundle Node.js and the generated server entrypoint. Tauri selects a free loopback port, creates a random per-launch connection token, launches the server, and terminates its Windows process tree with the window. Recovery preserves a healthy sidecar by default. Forced recovery terminates an unhealthy tree before starting a replacement.

### React projection

`apps/web` renders state received from the orchestration server. It does not read Kimi credentials, execute Git, spawn terminal processes, or call Kimi account APIs.

The renderer reconnects and requests a durable projection after a restart. Liveness-critical reads, session reattachment, and configuration calls have bounded waits. Streaming chunks stay under the turn that produced them and compact after completion.

### Orchestration server

`apps/server` owns:

- Kimi ACP session lifecycle
- Kimi authentication delegation and runtime configuration
- Durable events and thread projections
- Prompt admission, queueing, steering, and cancellation
- Finite background-task monitoring and UI notification
- Skill discovery and confirmed workspace-local installation
- Workspace-bound file and image context
- Git checkpoints and Git manager operations
- Local terminal processes
- Kimi usage probing
- Localhost preview control and screenshot capture
- Schedules, redacted exports, and restricted remote access

The server communicates with the renderer over a loopback WebSocket. Development accepts only the configured Vite origin. Packaged builds also require the random launch token from the Tauri shell.

## Kimi ownership boundary

Kimi Code CLI runs through Agent Client Protocol using `kimi acp`. It is the source of truth for:

- Account authentication and OAuth refresh
- Models and reasoning levels
- Permission modes and approvals
- Sessions and agent execution
- Commands, skills, subagents, and tools
- MCP behavior and Kimi configuration
- Subscription quota

The desktop app renders values returned by the active Kimi session and rejects values the runtime does not advertise.

Skills are discovered from Kimi and Agents user directories plus project-local equivalents. Built-in `coder`, `explore`, and `plan` entries are prompt shortcuts. Running-agent state comes only from real Kimi `Agent` tool and background-task events.

Trusted user MCP definitions come from the selected Windows Kimi instance's effective `KIMI_CODE_HOME`. Project discovery is limited to `.mcp.json` and `.kimi-code/mcp.json` beneath the canonical project root. The server computes a versioned SHA-256 fingerprint over that root plus each fixed path's presence and exact bytes. Opening a project exposes only redacted review metadata and never attaches project definitions.

The local desktop user must approve the exact fingerprint, reapprove after either file changes, and can revoke access. Approval changes are rejected while affected runtimes have active or pending work, and those runtimes are reset before the new policy can apply. WSL Kimi instances do not support project MCP approval. An approved, attachable project entry can override a same-named trusted user entry; unsupported project entries cannot suppress trusted user definitions, and the built-in preview name remains app-owned. The renderer and remote clients never receive raw URLs, headers, environment values, arguments, or credentials, and remote clients cannot approve or revoke project MCP access.

## Durable state

Thread activity is stored as validated JSONL events under the current user's app-data directory.

- Events are written before WebSocket publication.
- Sequence numbers remain monotonic.
- Replay streams from disk without retaining the full raw log in memory.
- Adjacent runtime chunks are coalesced.
- Completed history is atomically compacted into bounded thread snapshots.
- Text-only queue state is stored separately.
- Background-task registration, terminal status, and bounded `outputPath` are part of the projection.

When Kimi emits a finite task with `automatic_notification: true`, the server monitors its same-session task record. A terminal state and validated `outputPath` are recorded durably and published to the UI. The server does not enqueue a prompt or invoke a model when the task finishes. The user must explicitly ask Kimi to inspect the bounded output, or inspect it directly in the UI.

This design stays intentionally file-backed while there is one writer. A database becomes useful only when concurrent writers or indexed history queries become real requirements.

## Historical compatibility

Threads created by discontinued runtime adapters remain readable local history. They can be listed, exported, archived, restored, or deleted, but runtime actions are rejected with a prompt to start a Kimi chat. New sessions and resumed agent work use Kimi Code only.

The packaged app preserves `com.kimicode.desktop`, the single-instance mutex, and `kimi-code-desktop.preferences.v1`. These internal anchors preserve installed settings, local threads, updater identity, and mutual exclusion with earlier releases.

The server still accepts the legacy `TASTY_HOME` data-directory variable in addition to `KIMI_DESKTOP_HOME`. Remote compatibility identifiers are documented in [Remote Access](REMOTE_ACCESS.md) and [Automation and Exports](AUTOMATION.md).

## Workspace safety

File resources must resolve inside the active workspace, be text, and stay below configured size limits. Images are sent as ACP image blocks and are not stored in the persistent prompt queue.

ACP writes remain workspace-only. Background monitoring has one narrow Kimi-owned read exception: the server may read the active session's bounded task record and `output.log` beneath the Kimi session store. Canonical path checks reject traversal, symlink escapes, other session IDs, oversized records, and every other out-of-workspace file. Kimi reads the retained output only after an explicit user instruction.

Local skill installation accepts a regular Markdown file or a directory containing `SKILL.md` inside the active workspace. The `skill_install_local` tool requests confirmation but cannot install by itself. The confirmed operation revalidates symlinks, names, containment, size, depth, and entry count before staging the copy in the Kimi skills directory. Existing skills are never overwritten.

Git checkpoints use an alternate `GIT_INDEX_FILE`, `git write-tree`, and `git commit-tree`. They do not modify the user's branch or index. Per-turn revert applies only the recorded reverse diff and first creates a safety checkpoint. General destructive reset and discard operations are not exposed.

## Preview safety

Embedded preview accepts HTTP or HTTPS only when the hostname is exactly `localhost` or `127.0.0.1`.

Agent screenshot capture uses a fresh temporary Microsoft Edge profile and removes it after capture. The preview bridge requires its own random token and is not exposed to remote pages.

## Updates

Tagged builds run in GitHub Actions with protected Tauri signing secrets. The workflow publishes a Windows NSIS installer, updater signature, `latest.json`, and SHA-256 checksums. Tauri verifies the updater signature before installation. Microsoft Authenticode is a separate signing layer and is not currently configured.

## Data flow

```text
React UI
  <-> token-protected loopback WebSocket
Node orchestration server
  <-> Agent Client Protocol
Kimi Code CLI
  <-> Kimi account and runtime services
```

Git, terminal, files, and preview operations stay on the local Windows computer.
