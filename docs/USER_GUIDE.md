# User Guide

Kimi Code Desktop is a Windows interface for the official Kimi Code CLI. It uses the Kimi account, plan, configuration, sessions, and capabilities available to the current Windows user.

## Install and sign in

1. Download the newest installer from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest).
2. Run the installer and open Kimi Code Desktop.
3. Let onboarding check for Kimi Code CLI. If it is missing, choose **Open guide / check again** and follow Kimi's official instructions. The desktop app does not download or execute remote install scripts. Choose the button again after installation so onboarding can continue.
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
- Use **Set workspace goal** in the `+` menu to start Kimi's `/write-goal` workflow.

The `/` button is a toggle. Selecting it again closes command suggestions without inserting another character.

Model, reasoning, and permission choices come from the active Kimi ACP session. Kimi Code CLI `0.29.1` is the current verified reference runtime and can offer `Low`, `High`, and `Max` effort. The app shows every value the current session offers, including future values, and does not invent unsupported options. A legacy `Thinking On` value is shown as runtime-managed `Default`, not as `Max`.

## Control active work

While Kimi is working, a new prompt can be:

- **Queued** to run after the active turn. Queue is the default.
- **Steered** to cancel the current turn cleanly and prioritize the new direction.

Queued prompts appear in a compact row above the composer. They can be edited or removed before dispatch. Stop cancels the active turn and clears its pending queue.

Text-only queued prompts survive an app restart. Image payloads remain memory-only so large encoded data is not written into local history.

While work is active, short Kimi progress updates and one-line tool rows appear in chronological order. Tool details stay collapsed unless opened. When the turn finishes, this feed collapses into **Worked for ...**, followed by Kimi's final summary, token usage, a compact file-change report, and detected localhost preview links.

Some Kimi shell and agent tools can start a finite background task with automatic notification. The desktop app keeps those real task records in the chat projection, monitors them for up to 24 hours, and queues a follow-up when they finish so Kimi can inspect the output and report the verified result. This follow-up is crash-recoverable and at least once; it is not an exactly-once external delivery guarantee. Long-lived tools that disable their timeout are not monitored this way.

Use **Edit task** on a previous prompt to copy it back into the composer. If work is active, the app first cancels that turn and clears its queue. This does not rewrite Kimi's session history. **Undo changes** restores the filesystem checkpoint for that turn only.

Absolute Windows paths in prompts and summaries can be revealed in Explorer. Tool locations first open as text inside the work panel and fall back to Explorer for folders or non-text files.

## Commands, skills, plugins, and subagents

The capability center combines the live Kimi command catalog with local Kimi configuration:

- User skills from `%KIMI_CODE_HOME%\skills` (default `%USERPROFILE%\.kimi-code\skills`) and `%USERPROFILE%\.agents\skills`
- Project skills from `.kimi-code\skills` and `.agents\skills`
- User MCP definitions from `%KIMI_CODE_HOME%\mcp.json`
- Review-only project MCP definitions from `.mcp.json` and `.kimi-code\mcp.json`
- Installed plugin metadata from `%KIMI_CODE_HOME%\plugins`

A skill may be a folder containing `SKILL.md` or a flat Markdown file. Project definitions override same-named user definitions. The `$` menu searches this discovered inventory. It uses slash syntax only when the current Kimi command catalog advertises a matching command; otherwise it inserts `$skill-name` for Kimi to resolve.

To install a local skill, open a project, choose a skill file or folder from that active workspace, and confirm the install. Kimi may request the same workspace-local install through the built-in `skill_install_local` tool, but the request never installs anything by itself. Kimi Code Desktop always opens its confirmation dialog, and only your explicit **Install skill** action invokes the installer. The tool accepts no URLs or downloads. The confirmed install revalidates the manifest, name, symlinks, path containment, size, depth, and entry count before staging the copy in the user Kimi skills directory. Existing skills are never overwritten. Start a new chat after installation so Kimi loads the new skill.

Use Kimi's own commands, such as `/mcp-config` and `/update-config`, when the current runtime advertises them. Plugin management is shown only when Kimi exposes a matching command; the desktop app does not invent `/plugins`. Only user MCP definitions from `%KIMI_CODE_HOME%\mcp.json` are attached. Repository-controlled MCP files are shown as **Review only** and never execute just because a project was opened. Sensitive MCP headers, environment values, arguments, and credentials stay in the server process and are never sent to the renderer.

The `coder`, `explore`, and `plan` entries are convenient Kimi delegation prompts, not a fabricated running-agent inventory. Real Kimi `Agent` calls and their persisted background tasks appear in the **Agents** work-panel tab with their type, foreground or background mode, state, and agent ID when Kimi supplies one.

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

Use **Browser** to hand the URL to the Windows default browser. The preview panel always yields enough space to the chat composer, and wider preview presets collapse the left sidebar first.

### Kimi stops before finishing

The failed turn shows the runtime reason inline. The notification remains visible until dismissed and can copy the diagnostic or reveal `orchestration-server.log`. A transient renderer connection reconnects without restarting Kimi. After a sustained disconnect, recovery starts a new local service only when the previous service has actually exited.

If Kimi started a finite task with automatic notification, keep the chat available. The task remains in the Agents projection after the original turn ends. When it reaches a terminal state, the app queues a follow-up for Kimi to inspect the bounded same-session output and report success or the real failure. Arbitrary detached processes and development servers are not treated as completion notifications.

### Update installation fails

Download the newest installer directly from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest) and install it over the existing version. User settings and chat history are stored separately from the application binary.
