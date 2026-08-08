# Stabilize task completion handoff

Baseline: `9311ab1` plus the current renderer resilience diff.

## Problem

At completion, the newest assistant segment moves from the activity timeline to a separate final message while the expanded work content immediately unmounts. This looks like a teleport before the timeline collapses.

## Change

- Promote the final assistant summary only after `TurnCompleted`; ACP assistant chunks do not carry a reliable final-vs-progress marker.
- Collapse completed work to the existing `Worked for …` header without replaying the activity entrance on reopen.
- Keep command/tool rows compact and expandable; do not duplicate assistant text.
- Preserve current auto-collapse timing and persisted event projection semantics.
- Use no arbitrary delay and no new state machine; `TurnCompleted` remains the truthful semantic boundary.

## Verification

- Extend the activity source/render contracts for one final summary, stable ordering, and completed collapse.
- Preserve the existing auto-collapse test.
- Run web tests, web typecheck, and production build locally.
