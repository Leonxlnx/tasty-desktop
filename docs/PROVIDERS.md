# Provider runtimes

Tasty is a projection and orchestration layer. It does not replace provider CLIs, copy their credentials, or invent models and permissions that the current runtime does not expose.

## Shared behavior

Every provider can create project or standalone chats, stream messages and tool activity, queue and steer prompts, stop work, resume known sessions, persist local transcript state, and use `/goal` and `/side`.

The provider is fixed after a thread starts. A new draft can select another provider before its first prompt.

## Capability contract

Every provider descriptor declares whether its installed adapter supports models, reasoning, permissions, commands, images, quota, skills, MCP, plugins, and subagent activity, inspection, stop, or steering. The capability center renders that contract instead of projecting Kimi configuration onto another runtime. An unavailable capability remains visibly unavailable; Tasty does not synthesize a control that the adapter cannot execute.

Agent profiles are provider-bound reusable prompts with only the model, reasoning, and permission choices offered by that runtime at save time. On reuse, stale or removed choices are ignored and the provider default remains active. No current adapter exposes an enforceable per-agent turn or token limit, so profiles do not pretend to store one.

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
- Subagents: collaboration tool calls are projected into the Agents panel. Linked receiver thread IDs can be opened and inspected through `thread/read` with turns included. An active linked receiver can be stopped through the official `turn/interrupt` request.

Tasty rejects attempts to inspect or stop a subagent thread unless that thread ID was linked by a collaboration event in the parent thread. The current app-server contract does not expose child-thread steering, so Tasty does not show that action.

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

## OpenCode

- Binary: `opencode` on `PATH`
- Transport: OpenCode's official `opencode acp` Agent Client Protocol server
- Authentication: `opencode providers list`, `opencode providers login`, and `opencode providers logout`
- Runtime-owned features: sessions, models, reasoning variants, permissions, commands, images, agents, MCP servers, and plugins exposed by the installed OpenCode release

Tasty uses the local OpenCode credential store directly and never copies provider tokens. The adapter was checked against the official `opencode-ai` 1.18.5 Windows package and its advertised ACP command.

## Binary overrides

Contributors and portable installations can set an absolute path with one of these environment variables:

- `KIMI_BINARY`
- `CODEX_BINARY`
- `CLAUDE_BINARY`
- `CURSOR_BINARY`
- `OPENCODE_BINARY`

Tasty rejects a configured path that does not exist. Provider child processes inherit the user's environment and use hidden Windows process creation.

## Named instances

Create `provider-instances.json` inside the Tasty data directory to expose additional named runtimes in the composer provider picker. An instance references an existing provider CLI and provider-owned home directories; it never contains or copies an API key.

```json
[
  {
    "id": "work-codex",
    "name": "Work Codex",
    "provider": "codex",
    "environment": {
      "CODEX_HOME": "C:\\Users\\you\\.codex-work"
    }
  }
]
```

`id` is a stable 1–64 character identifier. `binary`, when present, must be an existing absolute path. Environment values must be absolute paths and are limited to provider-owned home/config variables: `KIMI_CODE_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CURSOR_CONFIG_DIR`, and the standard `XDG_*_HOME` variables used by OpenCode. Arbitrary environment variables and secret values are rejected. A thread persists its instance ID, and side chats inherit it.

### WSL instances

Kimi, Cursor, and OpenCode ACP runtimes can run inside an existing WSL user distribution. Tasty keeps workspace authorization on Windows, translates only absolute paths at the ACP boundary, and rejects unhealthy or system-only distributions such as `docker-desktop`.

```json
[
  {
    "id": "ubuntu-opencode",
    "name": "OpenCode in Ubuntu",
    "provider": "opencode",
    "wsl": {
      "distribution": "Ubuntu",
      "binary": "/usr/local/bin/opencode"
    }
  }
]
```

The Linux binary must already exist inside that distribution. Tasty does not install a distribution or CLI. Codex and Claude stay on Windows because their current adapters require Windows-native path and event semantics. Settings → Environments shows detected distributions and health without exposing configured binary or credential paths.

## Compatibility storage

Packaged Tasty keeps the legacy `com.kimicode.desktop` application identifier and `kimi-code-desktop.preferences.v1` browser key. These are internal compatibility anchors, not product branding. Changing either without migration would strand installed chat history, settings, and updater identity.

The bundled server accepts `TASTY_HOME`. `KIMI_DESKTOP_HOME` remains as a temporary compatibility alias for older development scripts.
