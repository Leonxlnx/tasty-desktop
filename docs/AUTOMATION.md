# Automation, Headless Control, and Private Exports

Kimi Code Desktop can schedule work in an existing Kimi chat, emit local completion events, export private chat archives, and accept commands from a paired headless client. These features reuse the desktop queue, Kimi runtime, permission checks, and remote allowlist.

## Scheduled tasks

Open a chat, then choose **Scheduled** in the sidebar or **Settings > Automations**. A schedule records:

- The existing target chat
- Its workspace, Kimi instance, and current permission mode
- The instruction, next run time, and Once, Daily, or Weekly recurrence

The app refuses to run a task if the chat is archived, removed, moved to another target, or changed to another permission mode. Recreate the schedule to confirm a new boundary. Recurring work advances to the next calendar slot after a missed run and does not replay a backlog. A one-time task disables itself when its slot is claimed.

The local desktop service must be running when a task is due. Scheduling is not a Windows background service and does not wake a sleeping computer.

## Headless CLI

Build the source CLI with the server:

```powershell
corepack pnpm@10.13.1 --filter @kimi-code-desktop/server build
node apps/server/dist/headless-cli.mjs pair ws://192.168.1.20:4318 ABCD-EFGH "My laptop"
```

Create the one-time code in **Settings > Remote access**. Commands after pairing:

```powershell
node apps/server/dist/headless-cli.mjs list
node apps/server/dist/headless-cli.mjs send <thread-id> "Run the tests"
node apps/server/dist/headless-cli.mjs steer <thread-id> "Stop and check the failing unit first"
node apps/server/dist/headless-cli.mjs stop <thread-id>
node apps/server/dist/headless-cli.mjs watch [thread-id]
```

The CLI is restricted to the remote method allowlist. It cannot access the terminal, arbitrary files, Git mutations, schedules, exports, diagnostics, or unregistered workspaces.

### Compatibility identifiers

The headless client writes its credential to `%USERPROFILE%\.kimi-code-desktop\headless.json`. `KIMI_DESKTOP_REMOTE_URL` and `KIMI_DESKTOP_REMOTE_TOKEN` can supply credentials without a file. The older `%USERPROFILE%\.tasty\headless.json`, `TASTY_REMOTE_URL`, and `TASTY_REMOTE_TOKEN` names remain read-only fallbacks for existing installations; new credentials are never written under the legacy name.

New clients prefer `kimi-code.remote.v1` with `kimi-code-token.<device-token>`, while also offering the legacy protocol and token identifiers when connecting. New servers accept both generations. This preserves existing pairings in either upgrade direction without copying or rewriting their token.

Do not place a remote token in shell history, repository files, logs, or command arguments. Revoke the device from the desktop app when a computer is lost or retired.

## Local notification events

Turn completion, failure, finished background work, and scheduled delivery emit local notification events. The desktop app shows them in its notice surface and may use a granted platform notification permission while hidden. Authenticated remote companions receive the same bounded event stream.

## Private chat archives

Use **Settings > Diagnostics** to export the current chat or every local chat. Kimi Code Desktop writes a JSON archive inside its local data directory and reveals it in Explorer. The export removes runtime session IDs, configuration options, raw tool input and output, credential-shaped fields, known home paths, and common secret patterns.

The archive still contains conversation text, summaries, file names, activity, and queued prompts. Review it before sharing. Kimi Code Desktop never uploads an archive automatically.
