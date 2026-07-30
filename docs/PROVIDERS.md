# Kimi Code Runtime

Kimi Code Desktop is a projection and orchestration layer for Kimi Code CLI. It does not replace the CLI, copy credentials, or invent models, reasoning levels, permissions, commands, or quota values.

## Runtime contract

- Binary: `%USERPROFILE%\.kimi-code\bin\kimi.exe` on Windows
- Transport: Agent Client Protocol through `kimi acp`
- Authentication: sign-in through `kimi login`; sign-out removes the Kimi credential file from its normal Kimi home
- Runtime-owned features: models, reasoning, permissions, resumable sessions, commands, skills, plugins, MCP servers, subagents, context, and plan quota
- Desktop additions: confirmed workspace-local skill installation, goals, side chats, Git checkpoints, terminal, localhost preview, schedules, and remote control

The runtime is fixed after a thread starts. The app resumes that ACP session before applying a configuration change so stale session IDs do not receive model, reasoning, or permission updates.

## Binary discovery

The default Windows path is `%USERPROFILE%\.kimi-code\bin\kimi.exe`. Contributors and portable installations can set `KIMI_BINARY` to an existing absolute path.

The app rejects a configured path that does not exist. The Kimi child process inherits the user's environment and uses hidden Windows process creation.

## Named Kimi instances

Create `provider-instances.json` inside the app data directory to expose an additional Kimi home in the composer. An instance references existing Kimi-owned paths and never contains an API key.

```json
[
  {
    "id": "work-kimi",
    "name": "Work Kimi",
    "provider": "kimi",
    "environment": {
      "KIMI_CODE_HOME": "D:\\KimiProfiles\\work"
    }
  }
]
```

`id` is a stable 1 to 64 character identifier. `binary`, when present, must be an existing absolute path. Environment values must be absolute paths and are limited to `KIMI_CODE_HOME` and the supported `XDG_*_HOME` variables. Arbitrary variables and secret values are rejected. Side chats inherit the selected instance.

Entries for discontinued runtimes are ignored so an old instance file cannot prevent valid Kimi instances from loading.

### WSL instances

A named Kimi instance can run inside an existing healthy WSL user distribution:

```json
[
  {
    "id": "ubuntu-kimi",
    "name": "Kimi in Ubuntu",
    "provider": "kimi",
    "wsl": {
      "distribution": "Ubuntu",
      "binary": "/usr/local/bin/kimi"
    }
  }
]
```

The Linux binary must already exist inside that distribution. Kimi Code Desktop does not install a distribution or CLI. Windows remains the canonical workspace authorization boundary, and system distributions such as `docker-desktop` are unavailable for agent work.

## Quota and context

ACP events provide turn and context usage. The complete plan quota comes from the official Kimi CLI `/usage` panel in an app-owned hidden workspace. The CLI owns OAuth refresh and network access. The desktop app parses only the percentage and reset rows rendered by the CLI and does not read tokens or call Kimi account APIs.

The interface does not infer a monthly limit when the installed CLI does not report one.

## Historical threads

Persisted threads from discontinued runtime adapters remain readable for compatibility. The app does not launch those runtimes, change their configuration, or relabel their content as Kimi. Start a new Kimi chat to continue the work.

## Storage compatibility

The application identifier `com.kimicode.desktop` and preference key `kimi-code-desktop.preferences.v1` are stable migration anchors. `TASTY_HOME` remains accepted as a legacy data-directory alias; `KIMI_DESKTOP_HOME` is also supported. These names are internal compatibility details, not current product branding.

See [Kimi ACP Runtime Notes](acp-runtime-notes.md) for the verified protocol behavior behind queueing, background tasks, skills, MCP, approvals, and quota.
