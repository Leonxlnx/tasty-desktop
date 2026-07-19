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

Kimi Code Desktop delegates authentication, model access, sessions, commands, skills, subagents, and subscription quota to the installed official Kimi Code CLI. The app must never read or copy credential contents.

The local orchestration service:

- Binds only to `127.0.0.1`
- Validates the Tauri or configured development origin
- Requires a random per-launch token in packaged builds
- Validates workspace file paths and sizes
- Keeps sensitive MCP configuration out of the renderer

The desktop preview accepts only HTTP or HTTPS URLs whose hostname is exactly `localhost` or `127.0.0.1`. Screenshot capture uses a fresh temporary Microsoft Edge profile that is removed after capture. It never reuses a person's browser profile, cookies, extensions, or logged-in sessions.

Published updates are signed with the Tauri updater key stored in GitHub Actions secrets. Tauri signing does not replace Microsoft Authenticode. Windows may show SmartScreen warnings until Authenticode is configured.

## Disclosure

Maintainers will acknowledge a complete report, investigate privately, and coordinate a fix and release before public disclosure when practical. Please allow reasonable time for verification and distribution.
