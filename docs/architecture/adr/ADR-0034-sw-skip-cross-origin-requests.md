---
id: ADR-0034
title: "Leave cross-origin requests to the browser instead of passing them through the Service Worker"
status: Proposed
date: 2026-10-19
related:
  - ateeducacion/moodle-playground#363
  - ateeducacion/moodle-playground#364
ai_assistance:
  tool: "Claude Code"
  model: "Claude Opus 5.5"
---

# ADR-0034: Leave cross-origin requests to the browser instead of passing them through the Service Worker

## Context

The `sw.js` fetch handler called `respondWith()` for every request and answered
cross-origin URLs with `fetchPassThrough()`, which returned `fetch()` of the
same request. That added nothing: without `respondWith()` the browser makes the
same request itself. The PHP worker is a Service Worker client, so blueprint
downloads (addon ZIPs, media) also went through the pass-through.

In Firefox, `respondWith(fetch(event.request))` never settles when the response
is a cross-origin redirect, e.g. `https://raw.githubusercontent.com//owner/...`
answers `307` with a relative `Location`. The download hangs; the retry in
`fetchPassThrough()` only runs on a thrown error. Chromium is not affected.
Moodle Playground hit this in #363 and fixed it in #364 (its ADR-0045).

## Decision

`shouldInterceptRequest(url, swOrigin)` in `src/shared/html-url-rewrite.js`
returns true only for same-origin URLs. The fetch handler returns before
`respondWith()` (and before cloning or buffering the request) when it is false.
`fetchPassThrough()` stays for same-origin shell and unscoped requests.

## Consequences

Cross-origin requests from Omeka pages and the PHP worker follow the browser's
normal CORS and redirect handling, including the external addon proxy. The
same-origin `__playground_proxy__` path is still intercepted. A future feature
that needs to rewrite a cross-origin response in the Service Worker must extend
`shouldInterceptRequest()`.

Evidence (Playwright, local build, 2026-10-19): `fetch()` of the URL above from
a controlled page hung for more than 20 s in Firefox before the change, and
Chromium returned 200. After the change both return 200.
