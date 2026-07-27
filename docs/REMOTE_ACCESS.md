# Remote access

Tasty can expose a second, opt-in WebSocket endpoint for a private companion device. The normal desktop endpoint remains on `127.0.0.1` with its per-launch token.

## Recommended setup

1. Install Tailscale or another user-owned private network on the Windows computer and phone.
2. Open **Settings → Remote access**.
3. Choose **LAN** for a private interface, or **Loopback** when a TLS/private-network proxy runs on the same computer.
4. Keep the selected port private. Tasty never changes Windows Firewall, opens a router port, or creates a public relay.
5. Select **Pair device** and enter the one-time code in the companion.

Raw `ws://` traffic is not encrypted. Use Tailscale, WireGuard, or a TLS reverse proxy whenever the network is not fully trusted. Do not expose the port directly to the public internet.

## Pairing and sessions

Pairing codes:

- contain eight unambiguous characters
- work once
- expire after ten minutes
- are limited to eight attempts per source per minute

The companion opens `/pair` and sends:

```json
{
  "id": 1,
  "method": "remote.claim",
  "params": { "code": "ABCD-EFGH", "name": "My phone" }
}
```

The response contains a device ID and a device token. Tasty stores only the SHA-256 hash of that token. Reconnect to `/remote` with WebSocket subprotocols `tasty.remote.v1` and `tasty-token.<device-token>`. The token is never placed in a URL or query log.

Device sessions are limited to 240 requests per minute and an 8 MiB WebSocket message. Revoking a device immediately closes all of its connections. Audit records contain timestamps, action names, device IDs, and bounded error details; they never contain prompts or tokens.

## Remote scope

Remote devices can list and create chats in existing Tasty workspaces, create standalone chats, stream activity, queue or steer prompts, stop work, answer approvals, update runtime-supported chat configuration, read quota, and inspect provider capabilities and checkpoints. They cannot introduce an arbitrary new host path; opening a new project remains a local desktop action.

Remote devices cannot manage provider login, application updates, remote configuration, skills, files, Git, terminals, diagnostics exports, or WSL settings. Those actions remain local to the desktop app.

## Recovery

The device token survives desktop restarts. A companion reconnects with bounded backoff, calls `env.bootstrap`, and resumes from the durable thread projection. If a device is revoked or the remote endpoint is disabled, it must pair again from the desktop app.
