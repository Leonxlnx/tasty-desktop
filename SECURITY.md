# Security Policy

## Supported versions

Only the latest published release receives security fixes.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Leonxlnx/tasty-desktop/security/advisories/new).

Do not open a public issue for:

- Credential or account-data exposure
- Workspace-boundary bypasses
- Local WebSocket or preview-bridge access
- Updater signature failures
- Unsafe Git or terminal behavior

Include the app version, Windows version, reproduction steps, impact, and whether the issue occurs with `KIMI_FAKE=1`. Never include real tokens, credentials, private source files, or unrelated personal data.

## Trust boundaries

Tasty delegates authentication, model access, and sessions to installed official provider CLIs. Kimi also remains authoritative for its commands, skills, subagents, MCP configuration, and subscription quota. Tasty must never read or copy credential contents.
If a CLI is missing, onboarding opens that provider's official installation guide only after a user click. It never downloads or executes a remote installation script.

The local orchestration service:

- Binds only to `127.0.0.1`
- Validates the Tauri or configured development origin
- Requires a random per-launch token in packaged builds
- Validates workspace file paths and sizes
- Allows bounded read-only access to the active Kimi session's own background-task record and `output.log`, and no other file outside the workspace
- Installs a local skill only from a validated non-symlink source inside the active workspace, after confirmation, without overwriting an existing skill
- Treats `skill_install_local` as a request only: the preview bridge cannot invoke installation RPCs, and a normal app window must show and receive explicit confirmation before the existing installer runs
- Attaches MCP definitions only from the user's Kimi home; repository MCP files are redacted for review and never auto-executed
- Keeps sensitive MCP configuration out of the renderer

Background-task records must resolve beneath the matching Kimi session and contain a validated finite task identifier. Monitoring expires after 24 hours and excludes tools that explicitly disable their timeout. A recovered completion can be queued at least once after a crash; callers must not treat the follow-up as exactly-once external delivery.

The desktop preview accepts only HTTP or HTTPS URLs whose hostname is exactly `localhost` or `127.0.0.1`. Screenshot capture uses a fresh temporary Microsoft Edge profile that is removed after capture. It never reuses a person's browser profile, cookies, extensions, or logged-in sessions.

Published updates are signed with the Tauri updater key stored in GitHub Actions secrets. Tauri signing does not replace Microsoft Authenticode. Windows may show SmartScreen warnings until Authenticode is configured.

## Disclosure

Maintainers will acknowledge a complete report, investigate privately, and coordinate a fix and release before public disclosure when practical. Please allow reasonable time for verification and distribution.
