# Kimi Code motion plans

Source baseline: `9311ab1` plus the uncommitted renderer resilience block.

These plans intentionally use the existing React and CSS stack. They remove replayed high-frequency motion, fix one transform bug, batch resize writes, keep task completion spatially stable, and preserve safe opacity feedback for reduced-motion users. Browser-based visual QA is prohibited for this project; every plan uses source contracts, unit tests, typecheck, and production build verification instead.

1. [Remove replayed high-frequency motion](001-remove-replayed-high-frequency-motion.md)
2. [Fix Jump to latest centering](002-fix-jump-to-latest-transform.md)
3. [Batch panel resize writes](003-batch-panel-resize.md)
4. [Stabilize task completion handoff](004-stabilize-task-completion-handoff.md)
5. [Preserve safe reduced-motion feedback](005-preserve-safe-reduced-motion-feedback.md)
