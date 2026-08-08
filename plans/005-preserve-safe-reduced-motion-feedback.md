# Preserve safe reduced-motion feedback

Baseline: `9311ab1` plus the current renderer resilience diff.

## Problem

Reduced-motion mode removes useful opacity feedback from several dialogs and notices, while the startup progress loop uses an easing curve that visibly accelerates and stalls.

## Change

- Keep transforms, travel, scaling, smooth scroll, and loops disabled for reduced motion.
- Allow only 60-90ms opacity feedback on modal backdrops, dialogs, notices, queue insertion, and the existing safe surfaces.
- Change the normal startup progress loop to linear timing.
- Keep the reduced-motion startup bar static.
- Do not animate blur, filters, height, width, or grid tracks.

## Verification

- Extend accessibility source contracts for the safe opacity allowlist and static startup bar.
- Run web tests, web typecheck, and production build locally.
