# Remote Access

Kimi Code Desktop can expose a second, opt-in WebSocket endpoint for a private companion device. The normal desktop endpoint remains on `127.0.0.1` with its per-launch token.

## Recommended setup

1. Install a user-owned private network such as Tailscale or WireGuard on the Windows computer and companion device.
2. Open **Settings > Remote access**.
3. Choose **LAN** for a private interface, or **Loopback** when a TLS or private-network proxy runs on the same computer.
4. Keep the selected port private. The app never changes Windows Firewall, opens a router port, or creates a public relay.
5. Select **Pair device** and enter the one-time code in the companion.

Raw `ws://` traffic is not encrypted. Use a private network or TLS reverse proxy whenever the network is not fully trusted. Do not expose the port directly to the public internet.

## Pairing and sessions

Pairing codes:

- Contain eight unambiguous characters
- Work once
- Expire after ten minutes
- Allow at most eight attempts per source per minute

The companion opens `/pair` and sends:

```json
{
  "id": 1,
  "method": "remote.claim",
  "params": { "code": "ABCD-EFGH", "name": "My phone" }
}
```

The response contains a device ID and token. Kimi Code Desktop stores only the SHA-256 hash of that token. New clients reconnect to `/remote` with the WebSocket subprotocols `kimi-code.remote.v1` and `kimi-code-token.<device-token>`.

New clients also offer `tasty.remote.v1` and `tasty-token.<device-token>` so they can connect to an older desktop server. New servers prefer the Kimi protocol, but continue to accept both legacy identifiers so existing paired clients keep working. The token is never placed in a URL or query log.

Device sessions are limited to 240 requests per minute and an 8 MiB WebSocket message. Revoking a device immediately closes all its connections. Audit records contain timestamps, action names, device IDs, and bounded error details, never prompts or tokens.

## Remote scope

Remote devices can list chats in known workspaces, create chats, stream activity, queue or steer prompts, stop work, answer approvals, update Kimi-supported chat configuration, read quota, and inspect checkpoints. Opening a new host folder remains a local desktop action.

Remote devices cannot manage Kimi login, application updates, remote configuration, skills, files, Git, terminal, diagnostics exports, or WSL settings. Those actions remain local to the desktop app.

## Recovery

The device token survives desktop restarts. A companion reconnects with bounded backoff, calls `env.bootstrap`, and resumes from the durable thread projection. If a device is revoked or remote access is disabled, it must pair again from the desktop app.

## Companion client

The reference companion is a private, dependency-free mobile PWA. It implements pairing, authenticated reconnect, projects, chats, live activity, queue, steer, stop, approvals, notifications, and offline app-shell caching. It has no analytics, third-party runtime scripts, or public relay. The companion remains private while its protocol and distribution model are validated.
