# Remove replayed high-frequency motion

Baseline: `9311ab1` plus the current renderer resilience diff.

## Problem

Switching chats remounts historical user messages and replays `message-in`. Send/Stop icon replacement replays `send-icon-in`. Menu scrubbing and keyboard autocomplete also interpolate state that should feel immediate.

## Change

- Remove the `message-in` animation from `.user-message` and delete its unused keyframes.
- Remove the `send-icon-in` animation from `.composer-submit svg` and delete its unused keyframes.
- Keep app menus mounted while a menu session is open, or remove their repeated entrance animation; do not animate pointer or keyboard scrubbing.
- Disable background/color interpolation for keyboard-selected autocomplete rows while preserving hover/focus feedback.
- Do not add an animation package, per-message state, timers, or mount bookkeeping.

## Verification

- Add source-contract tests proving historical messages and send/stop icons have no animation.
- Preserve queue first-mount feedback, dialog feedback, and running indicators.
- Run web tests, web typecheck, and production build locally.
