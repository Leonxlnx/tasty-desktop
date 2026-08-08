# Kimi ACP Runtime Notes

These notes describe behavior verified against Kimi Code CLI `0.29.1`. Future versions may expose additional runtime values. The desktop app treats ACP responses as authoritative.

The repository retains a `0.26.0` initialize/auth golden transcript as a compatibility fixture. It is not the current reference runtime and should not be rewritten to look like a newer CLI.

## Initialization

The installed CLI negotiates ACP protocol version 1 and reports:

- Agent name: `Kimi Code CLI`
- Authentication method: `login`
- Session list, load, and resume support
- Image and embedded prompt context support
- HTTP and SSE MCP support

Before login, creating a session returns an authentication-required error. The desktop app delegates sign-in to `kimi login` and never reads the resulting credential contents.

## Runtime configuration

The verified K3 session on Kimi Code CLI `0.29.1` exposes live model, reasoning effort, and permission options through ACP. Depending on the selected model and account, the runtime can offer `Low`, `High`, and `Max`.

The desktop app does not create effort choices locally. It renders the values returned by the session, accepts future values without a desktop release, and rejects values not offered by the active runtime. A legacy binary `Thinking On` value is shown as runtime-managed `Default`; it is not evidence that the runtime selected `Max`.

Draft controls use the freshest runtime catalog available. When a persisted chat opens after a server restart, the app resumes that ACP session before applying a configuration change. This prevents stale session IDs and refreshes any choices added by a newer CLI.

The Kimi child process starts with `KIMI_CODE_NO_AUTO_UPDATE=1` so a running session does not replace its own binary. Restart the desktop app after an intentional `kimi update`.

## Subscription usage

ACP session events expose context and turn usage but do not provide the complete subscription-window surface used by the desktop app.

For plan limits, the app launches the official Kimi CLI in an app-owned hidden workspace, invokes its local `/usage` panel, and parses only rendered percentage and reset rows. The CLI owns OAuth refresh and network access. The desktop app does not read tokens or call Kimi account APIs.

The verified panel reports weekly and five-hour windows but no monthly window. The interface does not infer one. Parsing remains generic so a future official monthly row appears without a desktop release.

## Prompt queue and steering

The desktop does not assume that an ACP session supports a separate mid-turn steering method.

- Queue appends a prompt to one server-owned FIFO per desktop thread.
- Steer places the new instruction first, cancels the current ACP turn, and dispatches after the persisted cancellation boundary.
- Stop cancels the current turn and clears pending prompts.

This prevents concurrent `session/prompt` calls against one ACP session.

## Background task completion

Kimi shell and `Agent` tool results can identify a finite detached task with a task ID, a supported status, and `automatic_notification: true`. The desktop registers only those explicit records and ignores tools that set `disable_timeout`.

The monitor reads only the matching task JSON beneath the active Kimi session. It accepts bounded finite task IDs, validates canonical paths, limits active and retained records, and expires a running task after 24 hours. When the task reaches a terminal state, the server records the completion and validated `outputPath`, then notifies the UI.

Registration, terminal status, and `outputPath` replay after a server restart. Completion does not enqueue a prompt, resume a turn, or invoke a model. The user must explicitly inspect the bounded output or ask Kimi to inspect it in a later prompt.

## Skills and subagents

Skills are discovered from `%KIMI_CODE_HOME%\skills` (default `%USERPROFILE%\.kimi-code\skills`), `%USERPROFILE%\.agents\skills`, and the active project's `.kimi-code\skills` and `.agents\skills` directories. Folder skills use `SKILL.md`; flat Markdown skills are also supported.

An install copies only a confirmed skill source inside the active workspace. The server rejects symlinks, traversal, invalid names, oversized or deeply nested bundles, excessive entry counts, and existing destinations. Installation does not alter credentials or create a competing skill store.

The capability center's `coder`, `explore`, and `plan` entries are prompt shortcuts. Running subagent state is projected from actual Kimi `Agent` tool output and persisted background-task events, not from those shortcuts.

## MCP configuration

User MCP definitions from the selected Windows Kimi instance's effective `%KIMI_CODE_HOME%\mcp.json` are translated into ACP session values. Standard HTTP, SSE, and stdio definitions are supported.

Project discovery reads only `.mcp.json` and `.kimi-code\mcp.json` beneath the canonical project root. Its versioned SHA-256 approval fingerprint frames the canonical root plus each fixed path's presence and exact bytes. Opening an untrusted repository exposes only redacted review metadata; attaching project definitions requires explicit local approval of that exact fingerprint. Any file change requires reapproval, and revocation removes the project definitions from future sessions.

Approval and revocation are rejected while affected Windows Kimi runtimes have active or pending work. Those runtimes are reset before the changed policy takes effect. WSL Kimi instances do not support project MCP approval. An approved, attachable project entry can override a same-named trusted user definition. Unsupported project entries cannot suppress trusted user definitions, and the built-in preview name remains app-owned. Raw URLs, headers, arguments, environment values, and credentials stay in the server process; renderer and remote clients receive metadata only, and remote clients cannot approve or revoke access.

ACP SDK `0.23.0` cannot express Kimi's OAuth MCP mode, so OAuth definitions are displayed but are not attached until a compatible upstream path exists.

## Approval identifiers

The verified upstream adapter uses `q{index}_opt_{index}` and `q{index}_skip` identifiers for question choices, and `plan_*` identifiers for plan review. The interface uses those namespaces only to choose a presentation and forwards every received option unchanged.
