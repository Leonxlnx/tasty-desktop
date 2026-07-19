# Kimi ACP Runtime Notes

These notes describe behavior verified against Kimi Code CLI `0.26.0`. Future versions may expose additional runtime values. The desktop app treats ACP responses as authoritative.

## Initialization

The installed CLI negotiates ACP protocol version 1 and reports:

- Agent name: `Kimi Code CLI`
- Authentication method: `login`
- Session list, load, and resume support
- Image and embedded prompt context support
- HTTP and SSE MCP support

Before login, creating a session returns an authentication-required error. The desktop app delegates sign-in to `kimi login` and never reads the resulting credential contents.

## Runtime configuration

The verified K3 session exposes live model, thinking, and permission options through ACP. Kimi Code CLI `0.26.0` currently reports `Thinking On` as its only thinking choice for this configuration.

The desktop app does not create Standard, High, Max, or future reasoning choices locally. It renders the values returned by the session and rejects values not offered by the active runtime.

Draft controls use the freshest runtime catalog available. When a persisted chat opens after a server restart, the app resumes that ACP session before applying a configuration change. This prevents stale session IDs and refreshes any choices added by a newer CLI.

The Kimi child process starts with `KIMI_CODE_NO_AUTO_UPDATE=1` so a running session does not replace its own binary. Restart the desktop app after an intentional `kimi update`.

## Subscription usage

ACP `0.26.0` exposes session and context usage but not subscription windows.

For plan limits, the app launches the official Kimi CLI in an app-owned hidden workspace, invokes its local `/usage` panel, and parses only rendered percentage and reset rows. The CLI owns OAuth refresh and network access. The desktop app does not read tokens or call Kimi account APIs.

The verified panel reports weekly and five-hour windows but no monthly window. The interface does not infer one. Parsing remains generic so a future official monthly row appears without a desktop release.

## Prompt queue and steering

ACP `0.26.0` exposes prompt and cancel, but no mid-turn steering method.

- Queue appends a prompt to one server-owned FIFO per desktop thread.
- Steer places the new instruction first, cancels the current ACP turn, and dispatches after the persisted cancellation boundary.
- Stop cancels the current turn and clears pending prompts.

This prevents concurrent `session/prompt` calls against one ACP session.

## MCP configuration

Kimi MCP definitions are read from the standard `~/.kimi/mcp.json` store and translated into ACP session values. Standard HTTP, SSE, and stdio definitions are supported.

Raw URLs, headers, arguments, and environment values stay in the server process. The renderer receives only redacted transport and target metadata.

ACP SDK `0.23.0` cannot express Kimi's OAuth MCP mode, so OAuth definitions are displayed but are not attached until a compatible upstream path exists.

## Approval identifiers

The verified upstream adapter uses `q{index}_opt_{index}` and `q{index}_skip` identifiers for question choices, and `plan_*` identifiers for plan review. The interface uses those namespaces only to choose a presentation and forwards every received option unchanged.
