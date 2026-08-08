# Fix Jump to latest centering

Baseline: `9311ab1` plus the current renderer resilience diff.

## Problem

`.jump-to-latest` uses `translateX(-50%)` for centering, but `menu-in` temporarily replaces the entire transform. When the animation ends the button snaps sideways.

## Change

- Remove the entry transform animation from the button.
- Keep `translateX(-50%)` as the only positioning transform.
- Preserve the existing centered active scale by composing it with `translateX(-50%)`.
- A short opacity-only entrance is acceptable only if it does not alter positioning.

## Verification

- Add a CSS source contract that the selector has no transform-changing animation.
- Run web tests, web typecheck, and production build locally.
