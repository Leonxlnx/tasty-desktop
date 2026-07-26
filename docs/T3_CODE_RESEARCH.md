# T3 Code research notes

This note records the locally inspected T3 Code architecture and the parts that informed Tasty. No browser-based verification was used.

## What T3 Code does well

- Uses the official Codex app server instead of scraping terminal text
- Separates provider runtime ingestion, orchestration intent, command dispatch, and UI projection
- Treats WebSocket push events as a typed boundary between server state and the React client
- Keeps the provider process and workspace operations on the machine that owns the environment
- Uses ordered queue workers so provider side effects remain deterministic
- Models remote environments and endpoint discovery separately from provider authentication
- Documents trust boundaries and lifecycle ownership instead of hiding them in UI code

## What Tasty adopted

- The official Codex app server transport
- One normalized runtime interface for ACP, app-server, and stream-json providers
- A server-owned durable event projection rather than renderer-only transcript state
- Provider-aware threads that cannot silently change runtime after creation
- Inspectable Codex subagent receiver threads with a parent-link authorization check
- Explicit interruption, queueing, steering, and lifecycle state

## What Tasty intentionally keeps simpler

- Windows-first Tauri packaging instead of a broader remote environment system
- A single local loopback server rather than LAN, hosted, or tunnel endpoints
- Existing React state and event-store patterns instead of introducing Effect or a shared contract package
- Provider adapters built from already installed dependencies

These omissions keep the current trust boundary small. Remote environments, shared contract generation, and richer multi-device orchestration should be added only when a concrete workflow needs them.

## Gaps still worth considering

1. Provider conformance fixtures for real version snapshots beyond Kimi
2. A capability matrix generated from adapter tests so documentation cannot drift
3. Stable provider event schemas shared between server and renderer
4. Remote environments with explicit pairing and transport security
5. Rich Claude subagent transcript inspection when its runtime exposes a stable child-session API
6. Cursor-specific session inspection when ACP exposes linked child sessions
7. A provider-neutral skills and MCP center instead of the current honest Kimi-only capability view

The first two items have the highest value for an open-source release because they improve compatibility without expanding the security boundary.
