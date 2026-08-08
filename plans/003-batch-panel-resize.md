# Batch panel resize writes

Baseline: `9311ab1` plus the current renderer resilience diff.

## Problem

Sidebar and work-rail pointer moves write grid-driving CSS variables for every delivered event, forcing repeated full-shell layout.

## Change

- Reuse the existing frame batching pattern to keep only the latest pointer position per animation frame.
- Flush the final pending width on pointer up before saving preferences.
- Cancel and clear the scheduled frame during cleanup.
- Preserve pointer capture, width clamps, left/right rail behavior, keyboard-accessible resizers, and final persisted width.
- Do not add a motion library or interpolate width with CSS.

## Verification

- Add one unit test proving multiple pointer samples collapse to one frame write and final flush wins.
- Preserve existing panel width boundary tests.
- Run web tests, web typecheck, and production build locally.
