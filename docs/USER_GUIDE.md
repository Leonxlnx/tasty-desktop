# User Guide

Kimi Code Desktop is a Windows interface for the official Kimi Code CLI. It uses the Kimi account, plan, configuration, sessions, and capabilities available to the current Windows user.

## Install and sign in

1. Download the newest installer from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest).
2. Run the installer and open Kimi Code Desktop.
3. Let onboarding check for Kimi Code CLI. If it is missing, the app can run Kimi's official Windows installer.
4. Select **Begin sign-in**.
5. Open Kimi's verification page and approve the displayed device code.

Signing out removes only the local Kimi OAuth credential. Kimi configuration, sessions, and desktop chat history remain on the Windows account.

## Projects and chats

Use **Projects** when Kimi should work inside a local folder. A project can contain multiple chats, and each chat can use workspace files, Git, terminal, and preview tools.

Use **Chats** for standalone conversations. Standalone chats use an app-owned workspace and do not expose project files, Git state, terminal commands, or previews.

Creating a chat first creates a draft. It becomes a durable Kimi session only after the first prompt is sent. The first prompt is also used to generate the chat name.

Project menu actions can:

- Rename the sidebar label
- Remove the project from the sidebar without touching its folder
- Delete the app's chat history for that project

Chat menu actions can rename, stop, open, or delete a chat. Right-clicking a project or chat opens the same menu as its three-dot action.

## Compose a prompt

- Press `Enter` to send.
- Press `Shift+Enter` for a new line.
- Use `+` to add files or images.
- Use `/` to open Kimi commands.
- Use `$` to search Kimi skills.
- Use `#` or `@` to search files in the active project.

The `/` button is a toggle. Selecting it again closes command suggestions without inserting another character.

Model, reasoning, and permission choices come from the active Kimi ACP session. The app does not invent options that the installed CLI does not support.

## Control active work

While Kimi is working, a new prompt can be:

- **Queued** to run after the active turn. Queue is the default.
- **Steered** to cancel the current turn cleanly and prioritize the new direction.

Queued prompts appear in a compact row above the composer. They can be edited or removed before dispatch. Stop cancels the active turn and clears its pending queue.

Text-only queued prompts survive an app restart. Image payloads remain memory-only so large encoded data is not written into local history.

Thinking and tool activity stay collapsed under the turn that produced them. Completed turns show duration, token usage, copy and revert controls, a compact file-change report, and detected localhost preview links.

## Commands, skills, plugins, and subagents

The capability center reads the current Kimi command catalog, skill directories, plugin manifests from `~/.kimi/plugins`, and MCP definitions from `~/.kimi/mcp.json`.

Use Kimi's own commands, such as `/mcp-config` and `/update-config`, to change CLI configuration. Sensitive MCP headers, environment values, arguments, and credentials stay in the server process and are never sent to the renderer.

Subagent shortcuts delegate to Kimi's official `coder`, `explore`, or `plan` agents. Real Kimi `Agent` calls appear in the **Agents** work-panel tab with their type, mode, state, and resumable agent ID when available.

## Work panel

Open the right work panel to switch between:

- Agents
- Changes
- Terminal
- File preview
- App preview

The panel can be resized and moved through Layout settings. Its tabs keep one compact header instead of stacking separate toolbars.

### Git changes

The Git manager supports status, diff, stage, unstage, and commit. Destructive discard and reset actions are intentionally omitted.

Turn checkpoints use a private alternate Git index. They do not change the user's current branch, index, or pre-existing dirty work.

### Terminal

Terminal commands run locally with the current Windows user's permissions in the selected project folder. The current implementation supports normal PowerShell commands and streamed output, but not full-screen interactive terminal programs.

### App preview

App preview accepts only local URLs whose hostname is exactly `localhost` or `127.0.0.1`. Kimi can open, resize, reload, and capture the preview through the built-in `kimi-desktop-preview` MCP.

Screenshot capture launches an isolated temporary Microsoft Edge profile. It does not reuse personal cookies, extensions, tabs, or logged-in sessions.

## Usage and context

Context usage comes from Kimi ACP events or local Kimi session records. Subscription quota comes from the official Kimi CLI `/usage` panel. The desktop app parses only the percentage and reset rows rendered by that panel.

If Kimi does not report a monthly window, the app does not infer one. Any future official window appears automatically when the installed CLI exposes it.

## Updates

The app checks the signed update feed at startup. When a newer version is available, Settings displays an update action with progress and an explicit install-and-restart step.

Published update packages are verified with Tauri updater signatures. Windows SmartScreen may still warn until the project also uses a Microsoft Authenticode certificate.

## Troubleshooting

### No model is available

Confirm that the signed-in Kimi account has Kimi Code access, then run:

```powershell
kimi provider list
```

Restart Kimi Code Desktop after `kimi update` so the app reloads the runtime catalog.

### A session no longer exists

Reopen the chat. The app resumes its persisted ACP session before applying model, reasoning, or permission changes.

### Local preview does not load

Confirm the development server is running and enter a complete local URL, such as `http://localhost:3000`. Remote URLs are rejected by design.

### Update installation fails

Download the newest installer directly from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest) and install it over the existing version. User settings and chat history are stored separately from the application binary.
