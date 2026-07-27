# Product roadmap

This roadmap turns the current local multi-provider harness into a complete coding workspace without replacing provider-owned agent behavior. Every checkpoint must end with focused tests, a green repository, a commit, and a push.

## Delivery rules

- Extend existing event, runtime, Git, terminal, command-palette, and design-system paths before adding new ones.
- Persist user-visible state before publishing it to a client.
- Keep provider credentials in the provider runtime.
- Keep browser-based verification and Computer Use disabled. Verify with local shell tests, builds, protocol probes, process inspection, and file integrity.
- Do not install, restart, or replace the running desktop app until the final release gate.
- A remote client never receives arbitrary filesystem access. It uses authenticated, workspace-scoped server commands.

## Product decisions

### Extend the current harness

Tasty already has durable events, provider adapters, checkpoints, queueing, terminal, Git, preview, a command palette, and a shared design system. New work extends those paths. A second orchestration framework would duplicate state and create more lifecycle races.

### Treat remote access as an environment boundary

Remote access connects a client to one Tasty execution environment. The environment owns providers, projects, sessions, terminals, Git, and filesystem operations. Access endpoints such as LAN, Tailscale, or a future tunnel do not become separate runtime implementations.

### Ship a private mobile PWA before an APK wrapper

The first companion is an installable mobile-first PWA in a separate private repository. This reaches Android and iPhone, keeps one protocol implementation, and can later be wrapped as an APK after pairing and reconnection stabilize. It is not a hosted credential proxy.

### Defer a public relay

A hosted relay adds account, abuse, retention, availability, and incident-response obligations. The first remote release supports direct authenticated access over a user-controlled LAN or private network and documents TLS or Tailscale deployment.

### Preserve runtime truth

Agent profiles, permissions, models, reasoning levels, subagents, skills, MCP servers, and plugins expose only capabilities supported by the selected provider instance. Tasty may store user intent and presentation preferences, but it does not invent provider behavior.

## Checkpoints

### 0. Contracts and delivery map

- Record this roadmap, security boundaries, and product decisions.
- Add machine-checkable acceptance items without deleting historical tasks.
- Preserve the existing public repository history and release process.

### 1. Turn lifecycle and diagnostics

- Use one durable lifecycle for admission, queueing, steering, running, stopping, checkpointing, completion, and failure.
- Reject stale session and turn actions deterministically.
- Expose bounded connection/runtime diagnostics and a redacted support bundle.

### 2. Isolated workspaces and archives

- Allow a project thread to use the main checkout or a dedicated Git worktree and branch.
- Keep worktree ownership explicit and never delete a dirty worktree silently.
- Archive and restore chats; sort projects and chats by meaningful recent activity.

### 3. Commands, keybindings, scripts, and editor handoff

- Expand the existing command palette into the global action surface.
- Persist user keybindings with context predicates and conflict validation.
- Discover project scripts and open the active workspace or file in a configured editor.

### 4. Terminal workspace

- Support durable terminal tabs, splits, focus, close, restart, and bounded scrollback.
- Attach selected terminal context to a prompt as explicit text context.
- Keep terminal processes bound to an authenticated client and workspace.

### 5. Git and review workspace

- Add branch, commit, push, clone, publish, and pull-request flows using installed provider CLIs.
- Present per-turn file trees and hunks with file/hunk revert and review comments.
- Preserve the user's pre-existing index and dirty work.

### 6. Extensions and agents

- Normalize skills, MCP servers, plugins, and commands across supported providers while preserving provider ownership.
- Add configurable agent profiles with runtime-supported model, limits, prompt, and permissions.
- Make linked subagents navigable and individually steerable or stoppable only when the provider supports it.

Status: complete. Profiles preserve provider-supported prompt/model/reasoning/permission state; no current adapter exposes an enforceable profile limit. Codex exposes linked inspection and stop, while unsupported steering remains absent.

### 7. Providers and instances

- Add OpenCode through its supported local server or ACP boundary.
- Allow named provider instances without copying credentials.
- Generate provider capability documentation from conformance fixtures.

Status: complete. OpenCode uses its official ACP command. Named instances select validated CLI/provider-home paths without accepting credentials, persist on threads, and inherit into side chats. Provider capability fixtures cover every adapter.

### 8. WSL and language intelligence

- Run the orchestration boundary inside a selected WSL distribution with explicit path translation and health checks.
- Project provider- or LSP-owned diagnostics without creating another editor language engine.

Status: complete. Named ACP instances can execute Kimi, Cursor, or OpenCode inside a healthy WSL user distribution while Windows retains the canonical workspace authorization boundary. Session roots and ACP file requests are translated explicitly in both directions. Provider tool activity, file locations, and diagnostics continue through the existing bounded activity projection; Tasty does not ship a competing LSP engine.

### 9. Secure remote environments

- Model an execution environment separately from its access endpoint.
- Add expiring one-time pairing, revocable device sessions, authenticated WebSocket reconnect, rate limits, and audit events.
- Support LAN or private-network access; recommend a user-owned TLS/private-network layer instead of shipping a public relay prematurely.

Status: complete. A disabled-by-default secondary listener supports loopback or private LAN binding, ten-minute single-use pairing, hashed and revocable device sessions, authenticated reconnect, per-source and per-device rate limits, bounded audit records, and a restricted remote method surface. Tasty does not change firewall/router state or ship a public relay; the UI and documentation recommend a user-owned private network or TLS termination.

### 10. Mobile companion

- Create a private mobile-first PWA repository that pairs with a Tasty environment.
- Support projects, chats, streaming activity, queue/steer/stop, approvals, notifications, and connection recovery.
- Keep an APK wrapper optional until the PWA protocol and UX are stable.

Status: complete. A separate private `tasty-remote` repository contains an installable, mobile-first PWA with direct pairing, authenticated reconnect, project and standalone chats, streaming activity refresh, queue/steer/stop, approvals, background notifications, offline shell caching, restrictive CSP, protocol tests, and passing CI. No APK wrapper or app-store dependency was added; the PWA is the stable protocol client first.

### 11. Headless automation and export

- Add a local headless CLI over the same authenticated contracts.
- Add persisted schedules with explicit workspace, provider, permissions, and next-run state.
- Export redacted private session archives and local notification events.

Status: complete. The local headless CLI pairs as a normal revocable remote device and exposes list, queue, steer, stop, and watch without a privileged bypass. Persisted schedules retain the target workspace, provider instance, permission mode, recurrence, and next-run state, skip missed-run backlogs, and refuse changed boundaries. The desktop UI manages schedules and writes explicit redacted chat archives locally. Completion, failure, background-task, and schedule events use one bounded notification channel.

### 12. UI, accessibility, and performance

- Refine the existing graphite design system instead of replacing it.
- Improve hierarchy, empty/loading/error states, responsive panels, focus, reduced motion, and long-session rendering.
- Keep the workspace visually continuous; avoid card soup, decorative gradients, and continuous GPU effects.

Status: complete. The final graphite pass removes the full-sidebar backdrop filter and decorative gradient, adds a keyboard skip link and clearer completion/error notices, keeps schedules responsive and refreshed from server events, and lazy-loads Markdown rendering. The main production JavaScript chunk fell from 686 kB to 532 kB (192 kB to 147 kB gzip) without adding a dependency.

## Final release gate

- All package typechecks and tests pass.
- Production services and the unsigned local installer build successfully.
- Security, provider, remote, user, and release documentation match the implementation.
- Public source and dependency checks pass.
- Installation or restart occurs only after explicit user approval.

Status: qualified locally. Final checks pass with 133/133 server tests, 81/81 web tests, 2/2 Rust tests, server/web TypeScript checks, Rust check, production server/web builds, zero known full or production dependency vulnerabilities, the public-source guard for 186 tracked files, and a clean diff. The unsigned Windows artifact is `Tasty_0.11.1_x64-setup.exe` (25,764,871 bytes; SHA-256 `F25538927C192F7FAB121E72984B07B1AAFE15A76969554A9C7A523F10569A93`). It has not been installed or launched.
