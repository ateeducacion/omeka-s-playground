---
id: ADR-0030
title: "Validate OPcache file-cache timestamps and blacklist the eval script path"
status: Proposed
date: 2026-10-17
---

# ADR-0030: Validate OPcache file-cache timestamps and blacklist the eval script path

## Context

`src/runtime/php-loader.js` has configured OPcache's *file cache* since the
first runtime: `opcache.enable=1`, `opcache.file_cache=/internal/shared/opcache`,
`opcache.file_cache_only=1` and — on the assumption that "the readonly bundle
never changes within a session" — `opcache.validate_timestamps=0`.

Two facts about php-src make that configuration behave differently from what it
suggests:

1. **On PHP ≤ 8.4 the cache never starts.** `accel_startup()` checks the SAPI
   name against a fixed whitelist (`apache`, `fastcgi`, `cli-server`, `cgi-fcgi`,
   `fpm-fcgi`, `apache2handler`, `litespeed`, `uwsgi`, `frankenphp`, …) before it
   looks at `file_cache_only`, and php-wasm reports `wasm`. The extension is
   unloaded, `opcache_get_status()` returns `false` and `/internal/shared/opcache`
   stays empty. Every measured "OPcache" benefit on PHP 8.1–8.4 was zero.
2. **PHP 8.5 removed the whitelist** (php-src `3088d6406847`, "Remove the Opcache
   SAPI whitelist"). This playground offers PHP 8.5 for every Omeka S version
   (`src/shared/omeka-versions.js`), so on that row the file cache is live today,
   with `validate_timestamps=0`.

With `validate_timestamps=0` the load path checks only the cache magic and
`system_id`, never the script's mtime, size or content. And in file-cache-only
mode `opcache_reset()` and `opcache_invalidate()` are no-ops (both guard on
`accelerator_enabled`, forced to `false`). So once a PHP file has been compiled
in a session, any rewrite of that path keeps executing the old bytecode until the
tab is closed: a module or theme reinstalled from the admin UI or by a blueprint
(`src/runtime/addons.js` extracts ZIPs over existing files), files placed by a
blueprint, a reloaded tab whose `/persist/addons` tree is hydrated over the
bundled core. The failure is silent — no error, wrong behaviour.

`PHP.run({ code })`, used by `php-compat.js`'s `run()` and the phpinfo capture,
writes every snippet to the same path, `/internal/eval.php`. All snippets share
one cache key and are protected only by PHP's `opcache.file_update_protection`
(default 2 s: a file modified less than 2 s before the request is not stored).

The premise of the original setting was also wrong for Omeka: the core bundle is
read-only, but `modules/` and `themes/` are symlinked into `/persist/addons`
and change within a session by design.

The same defect was found, measured in the browser and fixed in Moodle
Playground ([ADR-0038](https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0038-opcache-file-cache-timestamp-validation.md),
issue ateeducacion/moodle-playground#343): a file compiled once and rewritten
returned its old output on PHP 8.5, and the fix below restored the new output
with the cache still active.

## Decision

1. **Validate timestamps.** `opcache.validate_timestamps=1` and
   `opcache.revalidate_freq=0`, so every request compares the script's mtime
   (whole seconds in MEMFS) with the stored `.bin`. PHP's default
   `opcache.file_update_protection=2` is kept: a `.bin` is only stored for files
   at least 2 s old, so a stored entry always predates any rewrite of its path.
   `opcache.file_cache_consistency_checks` stays `0` (it checksums the `.bin`
   payload, not the source; unchanged behaviour).
2. **Blacklist the eval script.** `opcache.blacklist_filename` points at
   `/internal/shared/opcache-blacklist.txt`, which the loader writes before every
   `setPhpIniEntries()` call and which lists `/internal/eval.php`. The blacklist
   is honoured on store in file-cache-only mode, so `run({ code })` snippets are
   never cached regardless of timing.
3. **One source of truth.** The OPcache ini entries move to
   `src/runtime/opcache.js` (`OPCACHE_INI_ENTRIES`, `writeOpcacheBlacklist`), used
   by the request runtime and, through `createPhpRuntime`, by the CLI runtimes in
   `src/runtime/cli-runtime.js`.
4. **No new persisted state.** `/internal` is not journaled
   (`src/runtime/fs-persistence.js`), so the cache and the blacklist live and die
   with the WASM instance. Nothing is added to IndexedDB.

Nothing changes on PHP ≤ 8.4: the extension still does not start under `wasm`
there. [ADR-0031](ADR-0031-experimental-opcache-via-sapi-name.md) builds on this
decision to start the cache deliberately.

## Consequences

- On PHP 8.5 a rewritten PHP file executes its new code on the next request. The
  cache stays active for unchanged files, so the compile-time saving is kept.
- Two different contents written to the same path within the same second are
  still indistinguishable by mtime; `file_update_protection` makes that
  irrelevant for stored entries (the file must be ≥ 2 s old to be stored).
- `max_accelerated_files`, `memory_consumption` and `interned_strings_buffer`
  remain inert (no shared memory segment in file-cache-only mode) and are kept
  only so phpinfo reflects familiar values.
- A future PHP that keeps the whitelist removed behaves like 8.5 and is covered.

## Validation

- `tests/opcache.test.mjs` pins `validate_timestamps=1`, `revalidate_freq=0`,
  the blacklist path/content, the absence of a `file_update_protection`
  override, and that `writeOpcacheBlacklist()` creates the directory and file.
- `tests/e2e/opcache-canary.spec.mjs` installs the `OpcacheCanary` module
  fixture (a plain `canary.php` under the web root), compiles a 10 s old target
  returning `v1`, rewrites it to `v2` and asserts the second request returns
  `v2`, that `validate_timestamps` is `1`, and that the cache is live on PHP 8.5
  (`opcache_get_status().file_cache_only === true`) and inert on PHP 8.3 by
  default. Before this change the PHP 8.5 row returns `v1`.
- Prior art: Moodle Playground ADR-0038, same configuration and canary design.
