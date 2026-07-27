# User Guide

Tasty is a Windows desktop control panel for Kimi Code CLI, OpenAI Codex CLI, Anthropic Claude Code, Cursor Agent CLI, and OpenCode. It uses the accounts, sessions, models, and capabilities available to the current Windows user.

## Install and sign in

1. Download the newest installer from [GitHub Releases](https://github.com/Leonxlnx/tasty-desktop/releases/latest).
2. Run the installer and open Tasty.
3. Choose Kimi, OpenAI Codex, Anthropic Claude, Cursor, or OpenCode during onboarding.
4. If the provider CLI is missing, open its official guide and install it yourself. Tasty never downloads or executes remote install scripts.
5. Select **Sign in** and complete the provider CLI flow.

Signing out delegates credential removal to the selected provider CLI. Provider configuration, sessions, and Tasty chat history remain on the Windows account.

Named provider instances configured in `provider-instances.json` appear beside the defaults in the composer selector. Use them to point a chat at an existing work or personal CLI home without importing credentials into Tasty. The selected instance is fixed after the first message and inherited by side chats.

Open **Settings → Environments** to inspect Windows and installed WSL distributions. Healthy user distributions can back named Kimi, Cursor, or OpenCode instances; WSL system distributions are deliberately unavailable. Windows remains the default, and Tasty never installs Linux distributions or provider CLIs for you.

## Projects and chats

Use **Projects** when an agent should work inside a local folder. A project can contain multiple chats, and each chat can use workspace files, Git, terminal, and preview tools.

Use **Chats** for standalone conversations. Standalone chats use an app-owned workspace and do not expose project files, Git state, terminal commands, or previews.

Creating a chat first creates a draft. It becomes a durable provider session only after the first prompt is sent. The first prompt is also used to generate the chat name.

Project menu actions can:

- Create a new isolated chat in its own Git worktree and `tasty/*` branch
- Rename the sidebar label
- Remove the project from the sidebar without touching its folder
- Delete the app's chat history for that project

Chat menu actions can rename, stop, archive, restore, open, or delete a chat. Archived chats appear in the reversible **Archived** section. Tasty refuses to archive a chat while turns, approvals, queued prompts, or background reports are still pending. Archiving and deleting chat history never delete its Git worktree or branch silently. Right-clicking a project or chat opens the same menu as its three-dot action.

An isolated chat shows its branch in the top bar. Its agent, terminal, Git changes, checkpoints, and preview run from the worktree, while the chat remains grouped under the source project in the sidebar.

## Compose a prompt

- Press `Enter` to send.
- Press `Shift+Enter` for a new line.
- Use `+` to add files or images.
- Use `/` to open provider commands plus Tasty's `/goal` and `/side` commands.
- Use `$` to search Kimi skills when Kimi is active.
- Use `#` or `@` to search files in the active project.
- Use `/goal <objective>` or **Set goal** to persist an objective for the current chat.
- Use `/goal clear` to remove the objective.
- Use `/side [title]` to create a nested side chat with the same provider and workspace.

The `/` button is a toggle. Selecting it again closes command suggestions without inserting another character.

Model, reasoning, and permission choices come from the active provider runtime. Tasty renders each offered value and does not invent unsupported options. The provider can be changed while a chat is still a draft; an existing thread keeps its original provider.

## Control active work

While an agent is working, a new prompt can be:

- **Queued** to run after the active turn. Queue is the default.
- **Steered** to cancel the current turn cleanly and prioritize the new direction.

Queued prompts appear in a compact row above the composer. They can be edited or removed before dispatch. Stop cancels the active turn and clears its pending queue.

Text-only queued prompts survive an app restart. Image payloads remain memory-only so large encoded data is not written into local history.

While work is active, short plain-language progress updates and one-line tool rows appear in chronological order. Tool details stay collapsed unless opened. When the turn finishes, this feed collapses into **Worked for ...**, followed by the final summary, token usage, a compact file-change report, and detected localhost preview links.

Some Kimi shell and agent tools can start a finite background task with automatic notification. The desktop app keeps those real task records in the chat projection, monitors them for up to 24 hours, and queues a follow-up when they finish so Kimi can inspect the output and report the verified result. This follow-up is crash-recoverable and at least once; it is not an exactly-once external delivery guarantee. Long-lived tools that disable their timeout are not monitored this way.

Use **Edit task** on a previous prompt to copy it back into the composer. If work is active, the app first cancels that turn and clears its queue. This does not rewrite Kimi's session history. **Undo changes** restores the filesystem checkpoint for that turn only.

Absolute Windows paths in prompts and summaries can be revealed in Explorer. Tool locations first open as text inside the work panel and fall back to Explorer for folders or non-text files.

## Command palette and shortcuts

Open the global command palette with `Ctrl+K`. It searches app actions, projects, chats, and safe root-level `package.json` scripts. Selecting a script starts it in the active workspace terminal. The File menu and palette can also hand the active workspace to Visual Studio Code or Cursor, or reveal it in the system file manager.

General settings can record a different modifier shortcut for the palette, new chat, open folder, sidebar, terminal, and settings actions. A shortcut conflict is shown immediately and both conflicting actions remain disabled until one binding changes. Actions that need a provider or project are unavailable outside that context.

## Agent profiles, commands, extensions, and subagents

Open **Agents & extensions** to see the selected provider's actual runtime support. Capability chips distinguish supported models, reasoning, permissions, images, commands, and quota. Unsupported skills, MCP, plugins, and subagent actions use honest empty states instead of a fabricated Kimi inventory.

The **Profiles** tab saves a reusable prompt together with the current model, reasoning, and permission values when the provider exposes those controls. Profiles belong to one provider. Selecting **Use** applies only choices still advertised by the active runtime, skips stale choices safely, and places the saved instructions in the composer for review before sending. Tasty does not currently store a fake agent limit because none of the supported adapters exposes an enforceable per-agent limit.

For Kimi, the remaining tabs combine the live command catalog with local Kimi-owned configuration:

- User skills from `%KIMI_CODE_HOME%\skills` (default `%USERPROFILE%\.kimi-code\skills`) and `%USERPROFILE%\.agents\skills`
- Project skills from `.kimi-code\skills` and `.agents\skills`
- User MCP definitions from `%KIMI_CODE_HOME%\mcp.json`
- Review-only project MCP definitions from `.mcp.json` and `.kimi-code\mcp.json`
- Installed plugin metadata from `%KIMI_CODE_HOME%\plugins`

A skill may be a folder containing `SKILL.md` or a flat Markdown file. Project definitions override same-named user definitions. The `$` menu searches this discovered inventory. It uses slash syntax only when the current Kimi command catalog advertises a matching command; otherwise it inserts `$skill-name` for Kimi to resolve.

To install a local skill, open a project, choose a skill file or folder from that active workspace, and confirm the install. Kimi may request the same workspace-local install through the built-in `skill_install_local` tool, but the request never installs anything by itself. Tasty always opens its confirmation dialog, and only your explicit **Install skill** action invokes the installer. The tool accepts no URLs or downloads. The confirmed install revalidates the manifest, name, symlinks, path containment, size, depth, and entry count before staging the copy in the user Kimi skills directory. Existing skills are never overwritten. Start a new chat after installation so Kimi loads the new skill.

Use Kimi's own commands, such as `/mcp-config` and `/update-config`, when the current runtime advertises them. Plugin management is shown only when Kimi exposes a matching command; the desktop app does not invent `/plugins`. Only user MCP definitions from `%KIMI_CODE_HOME%\mcp.json` are attached. Repository-controlled MCP files are shown as **Review only** and never execute just because a project was opened. Sensitive MCP headers, environment values, arguments, and credentials stay in the server process and are never sent to the renderer.

The `coder`, `explore`, and `plan` entries are convenient Kimi delegation prompts, not a fabricated running-agent inventory. Real Kimi `Agent` calls and their persisted background tasks appear in the **Agents** work-panel tab with their type, foreground or background mode, state, and agent ID when Kimi supplies one.

Codex collaboration calls also appear in **Agents**. A linked child transcript can be inspected, and an active child can be stopped individually. Tasty verifies that the child thread was linked by the parent before either action. The installed Codex app-server does not currently expose child steering, so no steering button is shown. Other providers retain activity-only projection until their adapters expose stronger controls.

## Work panel

Open the right work panel to switch between:

- Agents
- Changes
- Terminal
- File preview
- App preview

The panel can be resized and moved through Layout settings. Its tabs keep one compact header instead of stacking separate toolbars.

### Git changes

The Git manager supports status, diff, stage, unstage, commit, local branch creation and switching, upstream-aware push, fast-forward-only pull, HTTPS/SSH clone, and turn-level patch copying. Open a completed turn's change report to review its recorded files and hunks, leave comments, and add the collected feedback to the next prompt. A file or hunk can be reversed after inline confirmation only when Git verifies that exact recorded turn patch still applies. Tasty saves a safety checkpoint first and remembers partial reversals across restarts. Branch changes rely on Git's own dirty-worktree protection. General discard and reset actions remain intentionally omitted.

Publishing and pull-request creation delegate to an already installed and authenticated GitHub CLI. Publishing defaults to private and requires an explicit button press; creating a pull request defaults to draft. Tasty does not store GitHub credentials. Clone accepts only explicit HTTPS or SSH URLs and asks you to choose the destination parent folder.

Turn checkpoints use a private alternate Git index. They do not change the user's current branch, index, or pre-existing dirty work.

### Terminal

Terminal commands run locally with the current Windows user's permissions in the selected project folder. Each project can keep multiple named terminal tabs, and two tabs can be viewed in a responsive split. Tab descriptors survive an app restart, but Tasty starts fresh shells after reconnecting; it never leaves an invisible process detached from the authenticated desktop session.

Output is bounded in memory. Use **Attach output to prompt** to deliberately append only the most recent output tail inside an explicit `<terminal_context>` block. Terminal output is never added to a prompt automatically. The current implementation supports normal PowerShell commands and streamed output, but not full-screen interactive terminal programs.

### App preview

App preview accepts only local URLs whose hostname is exactly `localhost` or `127.0.0.1`. An agent can open, resize, reload, and capture the preview through Tasty's built-in preview MCP.

Screenshot capture launches an isolated temporary Microsoft Edge profile. It does not reuse personal cookies, extensions, tabs, or logged-in sessions.

## Remote control

Remote control is off by default. **Settings → Remote access** can start a separate loopback or LAN listener, create a ten-minute one-time pairing code, and revoke paired devices. Prefer a user-owned private network such as Tailscale or a TLS reverse proxy. Tasty never opens a firewall or router port and does not expose a public relay. See [Remote access](REMOTE_ACCESS.md) for the protocol and security boundary.

## Schedules, headless control, and exports

Open the target chat, then select **Scheduled** in the sidebar. Once, Daily, and Weekly tasks retain that chat's workspace, provider instance, and permission mode. Tasty refuses a run when those boundaries changed. Missed recurring slots advance without replaying a backlog. The desktop service must be running and the computer awake when a task is due.

The paired headless CLI can list chats, queue or steer work, stop a turn, and watch events through the same restricted remote contract as a companion device. It has no terminal, filesystem, Git, schedule, export, or diagnostic access. See [Automation](AUTOMATION.md) for pairing and command examples.

Use **Settings → Diagnostics** to export one chat or all chats as a local, redacted JSON archive. The archive excludes session IDs, raw tool payloads, known private paths, and recognizable credentials, but it still contains conversation text. Review it before sharing. Nothing is uploaded automatically.

## Usage and context

Context usage comes from Kimi ACP events or local Kimi session records. Subscription quota comes from the official Kimi CLI `/usage` panel. The desktop app parses only the percentage and reset rows rendered by that panel.

If Kimi does not report a monthly window, the app does not infer one. Any future official window appears automatically when the installed CLI exposes it.

## Updates

The app checks the signed update feed at startup. When a newer version is available, Settings displays an update action with progress and an explicit install-and-restart step.

Published update packages are verified with Tauri updater signatures. Windows SmartScreen may still warn until the project also uses a Microsoft Authenticode certificate.

## Troubleshooting

Settings includes **Diagnostics > Export support bundle**. The JSON file is saved locally and contains bounded, redacted runtime errors plus version and active-work counts. It is never uploaded automatically. Review it before sharing. Private chat exports are separate and deliberately include redacted conversation history.

### No model is available

Confirm that the signed-in Kimi account has Kimi Code access, then run:

```powershell
kimi provider list
```

Restart Tasty after `kimi update` so the app reloads the runtime catalog.

### A session no longer exists

Reopen the chat. The app resumes its persisted ACP session before applying model, reasoning, or permission changes.

### Local preview does not load

Confirm the development server is running and enter a complete local URL, such as `http://localhost:3000`. Remote URLs are rejected by design.

Use **Browser** to hand the URL to the Windows default browser. The preview panel always yields enough space to the chat composer, and wider preview presets collapse the left sidebar first.

### Kimi stops before finishing

The failed turn shows the runtime reason inline. The notification remains visible until dismissed and can copy the diagnostic or reveal `orchestration-server.log`. A transient renderer connection reconnects without restarting Kimi. After a sustained disconnect, recovery starts a new local service only when the previous service has actually exited.

If Kimi started a finite task with automatic notification, keep the chat available. The task remains in the Agents projection after the original turn ends. When it reaches a terminal state, the app queues a follow-up for Kimi to inspect the bounded same-session output and report success or the real failure. Arbitrary detached processes and development servers are not treated as completion notifications.

### Update installation fails

Download the newest installer directly from [GitHub Releases](https://github.com/Leonxlnx/tasty-desktop/releases/latest) and install it over the existing version. User settings and chat history are stored separately from the application binary.
