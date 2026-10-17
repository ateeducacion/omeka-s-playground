---
id: ADR-0032
title: "Expose the experimental OPcache flag as an info panel toggle that restarts PHP without a reset"
status: Proposed
date: 2026-10-17
---

# ADR-0032: Expose the experimental OPcache flag as an info panel toggle that restarts PHP without a reset

## Context

[ADR-0031](ADR-0031-experimental-opcache-via-sapi-name.md) made OPcache's file
cache startable on PHP 8.1–8.4 behind `?opcache=1` (or `"opcache": true` in
`playground.config.json`), default off. The only way to turn it on was editing
the URL, so the soak period the ADR asks for before flipping the default
(ateeducacion/omeka-s-playground#194) had no practical way to collect users.

The info panel already hosts the Omeka and PHP version selectors with a
dirty-state "Apply & Reset" flow. That flow is destructive by design: a version
change clears the scope session and reloads the page so nothing leaks across
versions. Switching OPcache has no such requirement. The SAPI name is read once
when the PHP runtime starts, so a new worker is all that is needed, and the
persisted `/persist` journal, the scope and the blueprint source are unaffected.

Three ways to expose the flag were considered:

1. A checkbox next to the version selectors, applied through the existing
   button.
2. A banner or toast at boot inviting users to try OPcache.
3. No UI; flip the default after the soak.

## Decision

1. **Checkbox in the Configuration section** of the info panel, labelled
   "OPcache file cache (experimental, uses more memory)". It reflects
   `isOpcacheEnabled(currentOpcacheParam, config)`, so it shows the effective
   state whether it came from the URL or the config.
2. **Reload, not reset.** When only the checkbox differs from the running
   state, the panel shows a neutral note ("Applying restarts PHP to switch
   OPcache. Your data is kept.") and the button reads "Apply & Reload" without
   the danger style. Applying writes the parameter into the shell URL with
   `history.replaceState` and reloads only the runtime iframe through the
   existing `updateFrame()` path with the same scope and without `clean=1`. A
   version change in the same apply keeps the destructive "Apply & Reset" flow,
   which also carries the new `opcache` value in the reload URL.
3. **The URL stays the contract.** `opcacheUrlParam(enabled, config)` in
   `src/runtime/opcache.js` is the inverse of `isOpcacheEnabled()`: it yields
   `"1"`/`"0"` only when the choice differs from the config default and `null`
   otherwise, so the parameter is removed when the user returns to the default.
   A manual browser reload therefore preserves the choice through the same
   `?opcache=` handling ADR-0031 defined; nothing new is persisted.
4. **No boot-time banner.** The playground has no durable place to store that a
   banner was dismissed (sessionStorage is per tab, and the runtime is meant to
   stay ephemeral), so a banner would nag on every boot and push an
   experimental feature at people who only want Omeka S to load. Option 3 does
   not help the soak period. Both were rejected.

## Consequences

- Users can try OPcache without editing URLs; bug reports can state whether the
  checkbox was on. phpinfo keeps showing the SAPI's pretty name
  (`PHP WASM SAPI (JSPI)`), so the reliable indicator in the PHP tab is the
  "Opcode Caching: Up and Running" row.
- The runtime iframe reload discards the WASM instance and the compiled
  `.bin` files with it, as Reset Playground does, but keeps the SQLite database
  and `/persist`. Open form input inside Omeka is lost, like on any reload.
- The flag still defaults to off; flipping it remains the separate decision
  described in ADR-0031.

## Validation

- `tests/opcache.test.mjs` round-trips `opcacheUrlParam()` through
  `isOpcacheEnabled()` for every config default and asserts the parameter is
  omitted when the choice equals the default.
- `tests/e2e/shell.spec.mjs` "info panel hosts the version config with a
  dirty-state apply" covers the reload note, the button label and the fallback
  to the destructive flow when a version changes too.
- `tests/e2e/shell.spec.mjs` "enables experimental OPcache from the info panel
  and restarts PHP with the cache running" boots without the flag, asserts
  phpinfo's "Opcode Caching: Disabled", toggles the checkbox, applies, and
  asserts the frame keeps the same `scope=` without `clean=1`, the URL carries
  `opcache=1`, and phpinfo reports "Opcode Caching: Up and Running".
