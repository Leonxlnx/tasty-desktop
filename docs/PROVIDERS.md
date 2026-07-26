# Provider runtimes

Tasty is a projection and orchestration layer. It does not replace provider CLIs, copy their credentials, or invent models and permissions that the current runtime does not expose.

## Shared behavior

Every provider can create project or standalone chats, stream messages and tool activity, queue and steer prompts, stop work, resume known sessions, persist local transcript state, and use `/goal` and `/side`.

The provider is fixed after a thread starts. A new draft can select another provider before its first prompt.

## Kimi

- Binary: `~/.kimi-code/bin/kimi` or `kimi.exe`
- Transport: Agent Client Protocol through `kimi acp`
- Authentication: `kimi login` and `kimi logout`
- Runtime-owned features: models, reasoning effort, permission modes, resumable sessions, commands, skills, plugins, MCP servers, subagents, context, and plan quota
- Tasty-specific additions: confirmed workspace-local skill installation, goal metadata, side chats, Git checkpoints, and localhost preview tools

Kimi is the only provider for which Tasty currently renders subscription quota because it is the only supported runtime with a locally verified usage surface.

## OpenAI Codex

- Binary: `codex` on `PATH`
- Transport: official `codex app-server` JSON-RPC over standard input and output
- Authentication: `codex login --device-auth`, `codex login status`, and `codex logout`
- Runtime-owned features: threads, turns, models, reasoning effort, approvals, messages, commands, file changes, collaboration events, token usage, and interruptions
- Subagents: collaboration tool calls are projected into the Agents panel. Linked receiver thread IDs can be opened and inspected through `thread/read` with turns included.

Tasty rejects attempts to inspect a subagent thread unless that thread ID was linked by a collaboration event in the parent thread.

## Anthropic Claude

- Binary: `claude` on `PATH`
- Transport: Claude Code `stream-json` input and output
- Authentication: `claude auth login`, `claude auth status --json`, and `claude auth logout`
- Current models: Sonnet, Opus, and Haiku
- Current effort values: Low, Medium, High, and Max
- Current permission modes: Default, Plan, and Full access

Changing Claude configuration restarts the provider process and resumes the same session. Text, thinking, tool calls, tool results, usage, cancellation, and session resume are projected. Direct image transport is not implemented for the stream-json adapter yet, and the UI says so instead of silently dropping the attachment.

## Cursor

- Binary: `cursor-agent` on `PATH`
- Transport: Agent Client Protocol through `cursor-agent acp`
- Authentication: `cursor-agent login`, `cursor-agent about --json`, and `cursor-agent logout`
- Runtime-owned features: sessions, prompts, models, reasoning, permissions, and tool activity exposed by the installed ACP version

Cursor uses the same hardened ACP boundary as Kimi but no Kimi-specific home, quota, or capabilities are projected.

## Binary overrides

Contributors and portable installations can set an absolute path with one of these environment variables:

- `KIMI_BINARY`
- `CODEX_BINARY`
- `CLAUDE_BINARY`
- `CURSOR_BINARY`

Tasty rejects a configured path that does not exist. Provider child processes inherit the user's environment and use hidden Windows process creation.

## Compatibility storage

Packaged Tasty 0.10 keeps the legacy `com.kimicode.desktop` application identifier and `kimi-code-desktop.preferences.v1` browser key. These are internal compatibility anchors, not product branding. Changing either without migration would strand installed chat history, settings, and updater identity.

The bundled server accepts `TASTY_HOME`. `KIMI_DESKTOP_HOME` remains as a temporary compatibility alias for older development scripts.
