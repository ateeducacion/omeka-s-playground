---
id: ADR-0028
title: "Sentry error monitoring via a minimal hand-rolled envelope client"
status: Proposed
date: 2026-08-15
---

# ADR-0028: Sentry error monitoring via a minimal hand-rolled envelope client

## Context

Deployed playground sessions fail silently: the only trace of a broken session
is the in-page Logs panel, which the affected visitor rarely reports. There is
no server, so there are no server logs. A Sentry organization (`erseco`)
already hosts monitoring for sibling projects; the new project is
`omeka-s-playground` (EU/DE data region).

The shell (`src/shell/main.js`) is served as an unbundled ES module straight
from source, so an npm SDK cannot be bundled for it, and the app is otherwise
self-contained (no third-party CDN requests). The worker already funnels every
serious runtime failure to the shell as `kind: "error"` BroadcastChannel
messages, making the shell a natural single capture point for the whole stack.

## Decision

1. Implement a minimal Sentry client at `src/shared/monitoring.js` (~250
   lines, zero dependencies) that posts envelope payloads directly to the
   DSN's `/api/<id>/envelope/` ingest endpoint via
   `fetch(..., { keepalive: true })`, instead of `@sentry/browser` (~80 KB,
   needs bundling) or the CDN Loader Script (third-party request, blocked by
   ad blockers).
2. Enable it from the shell when `playground.config.json` provides
   `sentry.dsn`; without it the client is a no-op. Committed browser DSNs are
   public identifiers by design (they only authorize event submission).
3. Capture: uncaught `window` errors, `unhandledrejection`, `main()` boot
   failures, and every `kind: "error"` message relayed from the runtime
   worker. Tag events with `runtime`, `omekaVersion`, `phpVersion`, and use
   `BUILD_VERSION` as the release. Environment is auto-detected
   (`development` on localhost, `production` otherwise), overridable via
   `sentry.environment`.
4. Safety rails: hard 30-event session cap, per-session dedupe by event
   signature, fire-and-forget delivery, and capture paths that never throw
   into the app.

## Consequences

- Production failures become visible with version, runtime, and browser
  context attached; deployments without a DSN are unaffected.
- No breadcrumbs, session replay, or performance tracing; revisit toward the
  official SDK if those are ever needed.
- The envelope format (`sentry_version=7`, stable) is maintained by hand,
  pinned by unit tests in `tests/shared-monitoring.test.mjs`.
- Ad blockers commonly block Sentry ingest hosts; monitoring is best-effort
  telemetry, not an audit log.
