---
id: ADR-0035
title: "Turn the OPcache file cache on by default"
status: Proposed
date: 2026-10-19
deciders: [erseco]
related:
  issues: [194]
  adrs: [ADR-0030, ADR-0031, ADR-0032]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "Claude Opus 5.5"
---

# ADR-0035: Turn the OPcache file cache on by default

## Status

Proposed. Amends [ADR-0031](ADR-0031-experimental-opcache-via-sapi-name.md),
which kept the cache behind an experimental flag that was off by default. How
the cache starts (the `uwsgi` SAPI name) does not change.

## Context

ADR-0031 starts OPcache's file cache on PHP 8.1–8.4 by reporting the `uwsgi`
SAPI name. It shipped behind `?opcache=1` and `"opcache": false` in
`playground.config.json` while it soaked, and said that flipping the default
needs Omeka S measurements (boot, per-request time, memory).
[ADR-0032](ADR-0032-opcache-panel-toggle.md) added an info-panel toggle.
[ADR-0030](ADR-0030-opcache-file-cache-timestamp-validation.md) keeps the cache
safe with timestamp validation and the eval blacklist.

Issue #194 asked for a soak test and a decision on how to expose the cache.

## Problem

With the cache off, every Omeka S request compiles the Laminas MVC stack,
Doctrine and the module tree again, and most of a user's time in the
playground is spent navigating pages.

## Decision drivers

- Faster navigation for every user, not only those who know the flag.
- No regression in boot time, memory or stability.
- Users must still be able to turn it off.

## Options considered

1. **Keep it off by default.** Safe, but most users never get the speed-up.
2. **Turn it on by default and keep `?opcache=0` and the panel toggle.**
3. **Turn it on only in some browsers.** Not needed: Moodle Playground saw the
   same results in all three engines.

## Decision

Option 2. `playground.config.json` ships `"opcache": true`.
`isOpcacheEnabled()` does not change: a URL value still wins, and a config
without the key still means off. The panel toggle now unchecks to
`?opcache=0`.

## Consequences

- PHP 8.1–8.4 report `php_sapi_name() === "uwsgi"` by default. The ADR-0031
  audit found no Omeka S 4.2.1 or vendor code that branches on it (only
  `PHP_SAPI === 'cli'` checks, which `uwsgi` fails like `wasm`).
- Compiled bytecode in `/internal/shared/opcache` lives in the WASM heap for
  every visitor. It is still not journaled.
- Tests that need the `wasm` SAPI pass `?opcache=0`.

## Evidence

Omeka S 4.2.1, PHP 8.3, default blueprint, local dev server, Chromium
(Playwright), three fresh browsers per flag, 2026-10-19. Request times are
`fetch()` calls from `remote.html` through the Service Worker, median of the
five warm requests per page across the three runs:

| | off | on |
|---|---|---|
| Shell ready (boot) | 2355–3040 ms | 2373–2655 ms |
| `/admin` | 75 ms | 40 ms |
| `/admin/item` | 89 ms | 50 ms |
| `/admin/module` | 60 ms | 35 ms |
| `/admin/setting` | 95 ms | 70 ms |
| `/` (public site) | 129 ms | 144 ms |
| Peak RSS, browser process tree | 818 / 1143 / 1145 MB | 1156 / 1112 / 934 MB |

Admin pages are 1.4–1.9× faster; the public front page is unchanged within
noise. Boot time and peak memory do not change in any consistent way. There
were no PHP errors, WASM traps or recoveries.

Moodle Playground made the same change after measuring it in Chromium, Firefox
and WebKit: navigation was 2–3.5× faster, install and reload times were
unchanged, and peak browser RSS was about 400 MB lower with the cache
(ateeducacion/moodle-playground#353, ADR-0046 there, PR #369).

Not measured here: Firefox, Safari, and a real low-memory device or tablet.

## Validation

- `tests/e2e/shell.spec.mjs`: the panel toggle starts checked and turns the
  cache off (`?opcache=0`, phpinfo `Opcode Caching: Disabled`).
- `tests/e2e/opcache-canary.spec.mjs`: rows pass `?opcache=0` or `?opcache=1`
  explicitly; `OPCACHE_CANARY_MATRIX=8.3,8.3:opcache,8.4:opcache,8.5` passes.
- `tests/e2e/php85-install-script.spec.mjs`, `make test`, `make lint`, and the
  e2e jobs in CI.
