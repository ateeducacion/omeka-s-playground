---
id: ADR-0027
title: "Coherent selective crash recovery checkpoints"
status: Proposed
date: 2026-07-12
---

# ADR-0027: Coherent selective crash recovery checkpoints

## Context

Crash recovery must preserve a coherent checkpoint between SQLite (`/persist/mutable/db/omeka.sqlite`) and uploads (`/persist/mutable/files`) without re-reading the full upload tree during a runtime crash.

## Decision

1. Add a selective persistence flush API (`flushNow`) in `fs-persistence`.
2. In crash recovery, flush only pending upload operations before reading the DB snapshot.
3. Enforce a 16 MiB checkpoint bound for crash-time upload hydration.
4. If selective flush fails or exceeds the limit, skip taking a newer DB snapshot and recover from the last persisted checkpoint.
5. If persistence is unavailable, use a bounded in-memory upload fallback.

## Consequences

- Avoids full-tree upload snapshot spikes during crash handling.
- Keeps DB + uploads coherent at the same checkpoint boundary.
- May discard very recent changes when the bounded checkpoint fails, favoring consistency.
