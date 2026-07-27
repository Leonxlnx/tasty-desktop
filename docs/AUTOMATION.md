# Automation, headless control, and private exports

Tasty can schedule explicit work in an existing chat, emit local completion events, export private chat archives, and accept commands from a paired headless client. These features reuse the same queue, provider runtime, permission checks, and remote allowlist as the desktop app.

## Scheduled tasks

Open a chat, then choose **Scheduled** in the project sidebar or **Settings > Automations**. A schedule records:

- The existing target chat
- Its workspace, provider, named instance, and current permission mode
- The instruction, next run time, and Once, Daily, or Weekly recurrence

Tasty refuses to run the task if the chat is archived, removed, moved to another target, or changed to another permission mode. Recreate the schedule to confirm a new boundary. Recurring work advances to the next calendar slot after a missed run; it does not replay a backlog. A one-time task disables itself when its slot is claimed.

The local Tasty service must be running when a task is due. Scheduling is not a Windows background service and does not wake a sleeping computer.

## Headless CLI

The source CLI is built with the server:

```powershell
corepack pnpm@10.13.1 --filter @tasty/server build
node apps/server/dist/headless-cli.mjs pair ws://192.168.1.20:4318 ABCD-EFGH "My laptop"
```

Create the one-time code in **Settings > Remote access**. Pairing saves a revocable device token in `%USERPROFILE%\.tasty\headless.json` with user-only file permissions. Tokens use the WebSocket subprotocol and never appear in a URL or normal CLI output.

Commands after pairing:

```powershell
node apps/server/dist/headless-cli.mjs list
node apps/server/dist/headless-cli.mjs send <thread-id> "Run the tests"
node apps/server/dist/headless-cli.mjs steer <thread-id> "Stop and check the failing unit first"
node apps/server/dist/headless-cli.mjs stop <thread-id>
node apps/server/dist/headless-cli.mjs watch [thread-id]
```

`TASTY_REMOTE_URL` and `TASTY_REMOTE_TOKEN` may replace the credential file in controlled automation environments. Do not place the token in shell history, repository files, logs, or command arguments. Revoke the device from the desktop app when a machine is lost or retired.

The CLI is deliberately restricted to the remote method allowlist. It cannot access the terminal, arbitrary files, Git mutations, schedules, exports, diagnostics, or unregistered workspaces.

## Local notification events

Turn completion, failure, finished background work, and scheduled delivery emit local notification events. The desktop app shows them in its persistent notice surface and may use a granted platform notification permission while hidden. Remote companions receive the same bounded event stream after authentication.

## Private chat archives

Use **Settings > Diagnostics** to export the current chat or every local chat. Tasty writes a JSON archive inside its local data directory and reveals it in Explorer. The export removes provider session IDs, config options, raw tool input/output, credential-shaped fields, known home paths, and common secret patterns.

The archive still contains conversation text, summaries, file names, activity, and queued prompts. Review it before sharing because a user may have pasted sensitive prose that does not resemble a detectable credential. Tasty never uploads an archive automatically.
