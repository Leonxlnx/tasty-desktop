# Security Policy

## Supported versions

Only the latest published release receives security fixes.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Leonxlnx/kimi-code-desktop/security/advisories/new).

Do not open a public issue for:

- Credential or account-data exposure
- Workspace-boundary bypasses
- Local WebSocket or preview-bridge access
- Updater signature failures
- Unsafe Git or terminal behavior

Include the app version, Windows version, reproduction steps, impact, and whether the issue occurs with `KIMI_FAKE=1`. Never include real tokens, credentials, private source files, or unrelated personal data.

## Trust boundaries

Kimi Code Desktop delegates authentication, model access, agent execution, sessions, commands, skills, subagents, MCP configuration, plugins, and subscription quota to Kimi Code CLI. The desktop app must never read or copy credential contents. If the CLI is missing, the app opens the official installation guide only after a user action and does not execute a remote installer.

Chats created by discontinued runtime adapters are compatibility data. They can be read, exported, archived, or deleted, but cannot start or resume agent work.

The primary local orchestration service:

- Binds only to `127.0.0.1`
- Validates the Tauri or configured development origin
- Requires a random per-launch token in packaged builds
- Validates workspace file paths and sizes
- Allows bounded read-only access only to the active Kimi session's own background-task record and `output.log`
- Installs a local skill only from a validated non-symlink source inside the active workspace after confirmation
- Treats `skill_install_local` as a request that still requires explicit confirmation in the normal app window
- Attaches MCP definitions only from the trusted Kimi user store
- Keeps sensitive MCP configuration out of the renderer

Optional remote access uses a separate listener that is disabled by default. Pairing codes are single-use and expire after ten minutes. Device tokens are random, stored only as hashes, rate-limited, and individually revocable. Remote devices use a restricted chat-control method set and cannot invoke login, updates, terminal, Git, filesystem, skill installation, diagnostics export, or remote administration. Kimi Code Desktop does not open firewall or router ports and does not provide a public relay.

Background-task records must resolve beneath the matching Kimi session and contain a validated finite task identifier. Monitoring expires after 24 hours and excludes tools that explicitly disable their timeout. A recovered completion can be queued at least once after a crash, so callers must not treat the follow-up as exactly-once external delivery.

The desktop preview accepts HTTP or HTTPS only when the hostname is exactly `localhost` or `127.0.0.1`. Screenshot capture uses a fresh temporary Microsoft Edge profile that is removed after capture. It never reuses a personal browser profile, cookies, extensions, or signed-in sessions.

Published updates are signed with the Tauri updater key stored in GitHub Actions secrets. Tauri signing does not replace Microsoft Authenticode. Windows may show SmartScreen warnings until Authenticode is configured.

## Disclosure

Maintainers will acknowledge a complete report, investigate privately, and coordinate a fix and release before public disclosure when practical. Please allow reasonable time for verification and distribution.
