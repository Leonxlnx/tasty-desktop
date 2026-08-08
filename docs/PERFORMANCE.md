# Performance qualification

Kimi Code Desktop keeps the desktop renderer responsive by bounding the historical and high-volume data supplied to its React render paths. The automated helper-level and production-wiring evidence lives in `apps/web/src/performance.test.ts` and runs without a browser, network access, or production instrumentation. It is not a mounted-browser or GPU benchmark.

## Reproduce the evidence

From the repository root on Windows PowerShell:

```powershell
corepack pnpm@10.13.1 --dir apps/web test src/performance.test.ts --reporter=verbose
```

The test prints two compact metric records. The assertions, rather than the local elapsed times, are the primary proof:

| Workload | Required bound |
| --- | --- |
| 5,000 completed turns, one live turn, and 250 individually applied live deltas | Every delta replaces the live view; all 5,000 completed turn and message-array references remain stable after every delta |
| Same 5,001-turn session | The production initial window exposes 30 turns and keeps 4,971 older turns outside the render input |
| 2,000 short terminal chunks appended in 20 batches | At most 500 retained entries after every batch |
| 2,000 large terminal chunks appended in 20 batches | At most 500,000 retained characters after every batch |
| 50,000 diff lines | At most 1,200 rendered lines and 160,000 rendered characters |
| 50,000 Git rows | 60 rows in the initial DOM page |

The test also reads the production `App.tsx` source and verifies tightly scoped producer-to-consumer expressions for the conversation, terminal, diff, and Git render paths. This is a source-level integration contract. It catches expected call-site bypasses, but it is not an AST proof and does not measure browser layout, paint, memory, or frame rate.

The timing assertions are deliberately generous regression sentinels. They allow 15 seconds to prime the synthetic large-session projection, 5 seconds to apply its 250-delta stream, and 10 seconds for all terminal, diff, and Git helper workloads. They are intended to catch catastrophic regressions such as accidentally rebuilding unbounded history. They are not microbenchmarks, service-level objectives, or product-performance marketing claims.

## Reference run

On the local Windows qualification host on 2026-08-08, the command above reported:

```text
large-session-reference {
  turns: 5001,
  streamedDeltas: 250,
  changedViewReferences: 1,
  completedReferenceMismatches: 0,
  liveViewReferenceChanges: 250,
  visibleTurns: 30,
  hiddenTurns: 4971,
  primeMilliseconds: 30,
  updateMilliseconds: 61
}

bounded-render-inputs {
  terminalEntryLimit: 500,
  terminalCharacterLimit: 500000,
  diffLineLimit: 1200,
  diffCharacterLimit: 159849,
  gitRowLimit: 60,
  elapsedMilliseconds: 122
}
```

Vitest startup, TypeScript transformation, and module import time are outside these printed stopwatches and remain visible in the normal test report. Local elapsed times vary by host, power state, and concurrent processes; the reference counts and hard bounds do not.

## What this proves

- Individually applied live deltas update only the active turn projection while completed `TurnView` objects remain reusable by memoized React children.
- The conversation render path receives the production initial slice instead of the entire long session.
- Terminal output and unified diffs use hard-bounded render inputs under the tested defaults.
- Git changed files start with a 60-row render page and expand only through the explicit Show more control; this is progressive disclosure, not a hard total-row cap.

This proof is intentionally renderer-scoped. Server throughput, Kimi runtime latency, WebSocket latency, installer startup time, and GPU frame pacing require separate qualification and are not inferred from these tests.
