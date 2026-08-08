# User Guide

Kimi Code Desktop is a Windows desktop harness for Kimi Code CLI. It uses the Kimi account, sessions, models, permissions, commands, extensions, and quota available to the current Windows user.

## Install and sign in

1. Download the newest installer from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest).
2. Run the installer and open Kimi Code Desktop.
3. If Kimi Code CLI is missing, open its official installation guide from onboarding and install it yourself.
4. Select **Sign in** and complete the Kimi Code CLI flow.

Kimi Code Desktop never downloads or executes a remote installation script. Signing out delegates credential removal to Kimi Code CLI. Desktop chat history remains on the Windows account.

Named Kimi instances configured in `provider-instances.json` can point a chat at an existing work or personal Kimi home without importing credentials. The selected instance is fixed after the first message and inherited by side chats. See [Kimi Runtime](PROVIDERS.md).

Open **Settings > Environments** to inspect Windows and installed WSL distributions. A healthy user distribution can back a named Kimi instance. System distributions are deliberately unavailable, and the app never installs a distribution or CLI.

## Projects and chats

Use **Projects** when Kimi should work inside a local folder. A project can contain multiple chats. Each project chat can use workspace files, Git, terminal, and preview tools.

Use **Chats** for standalone conversations. Standalone chats use an app-owned workspace and do not expose project files, Git state, terminal commands, or previews.

Creating a chat first creates a draft. It becomes a durable Kimi session only after the first prompt is sent. The first prompt is also used to generate the chat name.

Project menu actions can:

- Create a chat in the current checkout
- Create an isolated chat in a Git worktree and `kimi/*` branch
- Rename the sidebar label
- Remove the project from the sidebar without touching its folder
- Delete the app's chat history for that project

Chat menu actions can rename, stop, archive, restore, open, or delete a chat. Archived chats appear in the reversible **Archived** section. The app refuses to archive a chat while turns, approvals, queued prompts, or background tasks are pending. Archiving or deleting chat history never deletes a Git worktree or branch silently. Right-click opens the same menu as the row action.

Chats created by discontinued runtime adapters remain visible as read-only history. They can be exported, archived, restored, or deleted, but they cannot run or resume agent work. Start a Kimi chat to continue their work.

## Compose a prompt

- Press `Enter` to send while idle or queue while Kimi is working.
- Press `Ctrl+Enter` to steer active work.
- Press `Shift+Enter` for a new line.
- Use `+` to attach files or images.
- Use `/` to open Kimi commands plus `/goal` and `/side`.
- Use `$` to search Kimi skills.
- Use `#` or `@` to search files in the active project.
- Use `/goal <objective>` to persist an objective for the current chat.
- Use `/goal clear` to remove the objective.
- Use `/side [title]` to create a nested side chat with the same Kimi instance and workspace.

The `/` button is a toggle. Selecting it again closes command suggestions without inserting another character.

Model, reasoning, and permission choices come from the active Kimi session. The app renders values Kimi advertises and does not create unsupported options locally.

## Control active work

Queue is the default while Kimi is working. A queued prompt runs after the active turn. Steering cancels the current turn at the durable cancellation boundary and places the new instruction first.

Queued prompts appear above the composer and can be edited or removed before dispatch. Stop cancels the active turn and clears its pending queue. Text-only queued prompts survive an app restart. Image payloads remain memory-only.

While work is active, short progress updates and compact tool rows appear in order. Tool details remain collapsed unless opened. When the turn finishes, activity compacts into **Worked for ...**, followed by the final summary, usage, file changes, and detected localhost links.

Some Kimi shell and agent tools start finite tasks with automatic notification. The server monitors only an explicit task record from the same Kimi session for up to 24 hours. When that task finishes, the app records its terminal state and bounded `outputPath`, then notifies the UI. It does not queue a prompt or invoke Kimi automatically. Inspect the output in the UI, or explicitly ask Kimi to inspect it and report the verified result.

Use **Edit task** on a previous prompt to copy it into the composer. If work is active, the app first cancels that turn and clears its queue. This does not rewrite Kimi session history. **Undo changes** restores the filesystem checkpoint for that turn only.

Absolute Windows paths in prompts and summaries can be revealed in Explorer. Tool locations open as text in the work panel when possible and fall back to Explorer for folders or non-text files.

## Command palette and shortcuts

Open the command palette with `Ctrl+K`. It searches app actions, projects, chats, and safe root-level `package.json` scripts. A selected script starts in the active workspace terminal. File actions can reveal the workspace or hand it to the configured editor.

General settings can change modifier shortcuts for the palette, new chat, open folder, sidebar, terminal, and settings. A shortcut conflict is shown immediately, and both conflicting actions remain disabled until one binding changes.

## Kimi commands, skills, MCP, and agents

Open **Agents & extensions** to inspect the Kimi features exposed by the active runtime and the local Kimi configuration discovered by the server.

The inventory includes:

- User skills from `%KIMI_CODE_HOME%\skills` and `%USERPROFILE%\.agents\skills`
- Project skills from `.kimi-code\skills` and `.agents\skills`
- User MCP definitions from the selected Windows Kimi instance's effective `%KIMI_CODE_HOME%\mcp.json`
- Project MCP definitions from `.mcp.json` and `.kimi-code\mcp.json` at the canonical project root
- Installed plugin metadata from `%KIMI_CODE_HOME%\plugins`
- Kimi commands advertised by the active session

A skill may be a folder containing `SKILL.md` or a flat Markdown file. Project definitions override same-named user definitions. The `$` menu searches this inventory.

To install a local skill, open a project, choose a skill file or folder from that workspace, and confirm the install. Kimi may request the same action through `skill_install_local`, but the request cannot install by itself. The app revalidates the source, manifest, name, symlinks, containment, size, depth, and entry count before copying it. Existing skills are never overwritten. Start a new chat so Kimi loads the installed skill.

Use Kimi's own commands, such as `/mcp-config` and `/update-config`, when the runtime advertises them. Plugin management appears only when Kimi exposes a matching command.

Opening a repository never enables its MCP configuration. **Agents & extensions** shows redacted project metadata and asks the local desktop user to approve the exact configuration. Approval covers the canonical project root, whether each fixed MCP file exists, and its exact bytes. Edit either file and the status changes to require reapproval; use **Revoke** to stop attaching the project definitions. The app refuses approval changes while affected Kimi runtimes have active or pending work, then resets those runtimes before applying a new policy.

Project MCP approval is available only for Windows Kimi instances, not WSL instances. An approved, attachable project entry can override a same-named trusted user definition. Unsupported project entries cannot suppress trusted user definitions, and the built-in preview name remains app-owned. Sensitive URLs, headers, environment values, arguments, and credentials stay in the server process. Remote devices receive no project-approval metadata and cannot approve or revoke access.

The `coder`, `explore`, and `plan` entries are prompt shortcuts, not fabricated running agents. Real Kimi `Agent` calls and persisted background tasks appear in the **Agents** work-panel tab with the state and identifiers Kimi provides. Controls remain absent when the installed Kimi runtime does not expose the required operation.

## Work panel

The side work panel switches between:

- Agents
- Changes
- Terminal
- File preview
- App preview

The panel can be resized and moved to either side through Layout settings. Its tabs share one compact header. The app preserves a usable conversation column: when the window cannot fit both the 260 px minimum work panel and the conversation reserve, the work panel stays hidden until enough width is available.

At 680 px or narrower, navigation becomes a 60 px icon rail. The sidebar button opens the full navigation as an overlay drawer instead of pushing the conversation or work panel aside.

### Git changes

The Git manager supports status, bounded diffs, stage, unstage, commit, local branch creation, switching and renaming, safe local branch deletion, remote branch filtering and tracking, upstream-aware push, fast-forward-only pull, HTTPS or SSH clone, and turn-level patch copying. Large file and branch inventories are revealed in bounded pages instead of mounting every row at once.

Branch rename, tracking, and deletion confirmations appear beside the selected branch. Delete starts with **Cancel** focused, `Escape` cancels, and focus returns to the triggering row action. Git still refuses to delete the current branch or a branch that is not fully merged.

The displayed status is a local snapshot, not a claim that the remote is current. It refreshes after Git-changing terminal commands and when the app regains focus or becomes visible.

A completed turn's change report can show recorded files and hunks, collect review comments, and add that feedback to the next prompt. A file or hunk can be reversed after confirmation only when Git verifies that the exact recorded turn patch still applies. The app creates a safety checkpoint first and remembers partial reversals across restarts. Branch changes rely on Git's dirty-worktree protection. Broad reset and discard actions are intentionally omitted.

Publishing and pull request creation delegate to an installed and authenticated GitHub CLI. Publishing defaults to private and requires an explicit action. Pull requests default to draft. Kimi Code Desktop does not store GitHub credentials.

Turn checkpoints use a private alternate Git index. They do not change the current branch, normal index, or pre-existing dirty work.

### Terminal

Terminal commands run with the current Windows user's permissions in the selected project folder. A project can keep multiple named terminal tabs and a responsive two-tab split. Tab descriptors survive a restart, but fresh shells start after reconnecting. The app does not leave an invisible process detached from the authenticated desktop session.

Output is bounded in memory. **Attach output to prompt** appends only the selected recent output inside an explicit `<terminal_context>` block. Terminal output is never added automatically. Normal PowerShell commands and streaming output are supported; full-screen interactive terminal programs are not.

### App preview

App preview accepts only URLs whose hostname is exactly `localhost` or `127.0.0.1`. Kimi can open, resize, reload, and capture the preview through the built-in preview MCP.

Screenshot capture launches a temporary isolated Microsoft Edge profile. It does not reuse personal cookies, extensions, tabs, or signed-in sessions.

## Remote control

Remote control is off by default. **Settings > Remote access** can start a separate loopback or LAN listener, create a ten-minute one-time pairing code, and revoke paired devices. Prefer a user-owned private network or TLS reverse proxy. The app never opens a firewall or router port and does not provide a public relay.

See [Remote Access](REMOTE_ACCESS.md) for the protocol and security boundary.

## Schedules, headless control, and exports

Open the target chat, then select **Scheduled** in the sidebar. Once, Daily, and Weekly tasks retain that chat's workspace, Kimi instance, and permission mode. The app refuses a run when those boundaries change. Missed recurring slots advance without replaying a backlog. The desktop service must be running and the computer awake when a task is due.

The paired headless CLI can list chats, queue or steer work, stop a turn, and watch events through the restricted remote contract. It has no terminal, filesystem, Git, schedule, export, or diagnostic access. See [Automation and Exports](AUTOMATION.md).

Use **Settings > Diagnostics** to export one chat or all chats as a local redacted JSON archive. The archive excludes session IDs, raw tool payloads, known private paths, and recognizable credentials, but still contains conversation text. Review it before sharing. Nothing is uploaded automatically.

## Usage and context

Context use comes from Kimi ACP events or local Kimi session records. Subscription quota comes from the official Kimi CLI `/usage` panel. The desktop app parses only percentage and reset rows rendered by that panel.

If Kimi does not report a monthly window, the app does not infer one. A future official row can appear when the installed CLI exposes it.

## Updates

The app checks its signed update feed at startup. When a newer release is available, the sidebar and Settings show an explicit install-and-restart action with progress.

Tauri verifies update signatures. Windows SmartScreen may still warn until the project also uses a Microsoft Authenticode certificate.

## Troubleshooting

### Kimi Code CLI is not found

Install Kimi Code CLI from its official guide, then restart the desktop app. Set `KIMI_BINARY` only when using a valid non-default local path.

### No model is available

Confirm that the signed-in account has Kimi Code access, then run:

```powershell
kimi provider list
```

Restart Kimi Code Desktop after `kimi update` so the app reloads the runtime catalog.

### A session no longer exists

Reopen the chat. The app resumes its persisted ACP session before applying model, reasoning, or permission changes. If Kimi no longer knows the session, start a new Kimi chat and keep the previous transcript as history.

### Local preview does not load

Confirm the development server is running and enter a complete local URL such as `http://localhost:3000`. Remote URLs are rejected. **Browser** hands the URL to the Windows default browser.

### Kimi stops before finishing

The failed turn shows the runtime reason inline. Copy the sanitized diagnostic or reveal `orchestration-server.log` from the notice when available. A transient renderer disconnect reconnects without restarting Kimi. Forced recovery starts a new local service only after the previous service exits.

Finite tasks with automatic notification remain in the Agents projection after the original turn ends. When one reaches a terminal state, the app records its bounded same-session output location and notifies the UI. It does not send an automatic follow-up. Inspect the output directly or ask Kimi to inspect it in a new prompt. Arbitrary detached processes and development servers are not treated as completion notifications.

### Update installation fails

Download the newest installer from [GitHub Releases](https://github.com/Leonxlnx/kimi-code-desktop/releases/latest) and install it over the existing version. Settings and chat history are stored separately from the application binary.
