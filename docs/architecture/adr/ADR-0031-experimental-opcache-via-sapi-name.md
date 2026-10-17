---
id: ADR-0031
title: "Experimental OPcache activation by reporting a whitelisted SAPI name"
status: Proposed
date: 2026-10-17
---

# ADR-0031: Experimental OPcache activation by reporting a whitelisted SAPI name

## Context

[ADR-0030](ADR-0030-opcache-file-cache-timestamp-validation.md) established that
OPcache's file cache, configured since the first runtime, never starts on PHP
8.1–8.4: `accel_startup()` only accepts a fixed list of SAPI names (`apache`,
`fastcgi`, `cli-server`, `cgi-fcgi`, `fpm-fcgi`, `fpmi-fcgi`, `apache2handler`,
`litespeed`, `uwsgi`, `fuzzer`, `frankenphp`, `ngx-php`; `cli`/`phpdbg` only
with `enable_cli`) and php-wasm reports `wasm`. Every Omeka request therefore
recompiles every PHP file it loads — the Laminas MVC stack, Doctrine, the
module tree — on every request.

php-wasm exposes `PHP.setSapiName()`, which changes the value `php_sapi_name()`
and `PHP_SAPI` report before the runtime starts; WordPress Playground's request
handler uses it (`cli`) and the hot-swap path re-applies it. Reporting a
whitelisted name is enough for the extension to start under php-wasm; the name is
otherwise inert — php-wasm's own SAPI (request parsing, headers, output) does not
change.

Moodle Playground measured the effect of a live file cache on isolated copies
([ADR-0039](https://github.com/ateeducacion/moodle-playground/blob/main/docs/architecture/adr/ADR-0039-experimental-opcache-via-sapi-name.md),
issue ateeducacion/moodle-playground#344): cold start −3.0 s (−33 %), PHP time
per request 58 → 17 ms, WASM linear memory +32…71 MiB. Omeka S has not been
measured; its per-request PHP cost is dominated by the same pattern (large
framework compiled on every request), so the mechanism is expected to apply but
the numbers are not assumed.

Choosing the name requires knowing what the application does with it. Audit of
the Omeka S 4.2.1 release and of the shipped fork tree
(`ateeducacion/omeka-s@feature/experimental-sqlite-support-4.2`, including
`vendor/`), every `php_sapi_name()` / `PHP_SAPI` reference:

| Location | Branch | Under `uwsgi` |
| --- | --- | --- |
| `application/src/Mvc/MvcListeners.php:75` | `PHP_SAPI === 'cli'` skips web-only listeners for CLI runs | false, same as `wasm` |
| `application/src/Controller/Admin/SystemInfoController.php` | displays `php_sapi_name()` on System information | shows `uwsgi` |
| `vendor/autoload.php`, `vendor/composer/platform_check.php` | `cli`/`phpdbg` → plain-text error output | false, same as `wasm` |
| `vendor/laminas/laminas-http/src/PhpEnvironment/Request.php:513` | `PHP_SAPI === 'cli'` request-URI detection | false, same as `wasm` |

No reference to `uwsgi`, `cgi`, `fcgi`, `fpm`, `apache` or `litespeed` exists in
the application or vendor trees. `cgi-fcgi`/`fpm-fcgi` were rejected on
principle: PHP's own CGI/FastCGI header handling (`Status:` line) and many
libraries branch on `cgi` substrings, and `cli` must not be used because Omeka's
MVC listeners and Laminas treat it as a console run.

## Decision

1. **Opt-in flag, default off.** `?opcache=1` on the shell URL, or
   `"opcache": true` in `playground.config.json` (shipped as `false`), starts
   the file cache. `?opcache=0|false|off|no` disables it regardless of the
   config. `isOpcacheEnabled(param, config)` in `src/runtime/opcache.js` holds
   the rule. The parameter travels shell → `remote.html` → worker URL like the
   runtime selection does (`src/shared/paths.js` `resolveRemoteUrl`,
   `src/remote/main.js`, `php-worker.js`); it is not persisted anywhere.
2. **SAPI name `uwsgi`.** When enabled, `createPhpRuntime()` calls
   `php.setSapiName("uwsgi")` immediately after constructing the `PHP` instance
   and before any request, so PHP reads it at startup. `OPCACHE_SAPI_NAME` in
   `src/runtime/opcache.js` is the single place the name lives.
3. **Only the request runtime.** CLI runtimes spawned by
   `src/runtime/cli-runtime.js` are short-lived and keep the default (inert)
   configuration; `createPhpRuntime` defaults `opcache` to `false`.
4. **Requires ADR-0030.** The flag is only safe with timestamp validation and the
   eval blacklist in place; this ADR does not change the ini entries.
5. **PHP 8.5 is unaffected** by the flag: its cache is live either way (the
   whitelist no longer exists), and the flag only changes the reported SAPI name
   there.

Flipping the default to `true` is a separate decision: it needs measurements on
Omeka S (boot time, per-request time, memory under the 128 MiB initial /
growable WASM heap) and a soak period with the flag.

## Consequences

- Operators and CI can measure OPcache on PHP 8.1–8.4 with one URL parameter and
  no rebuild; nothing changes for existing visitors.
- With the flag, `PHP_SAPI` reads `uwsgi` in phpinfo and on the admin System
  information page. Support requests quoting that value are telling us the flag
  was on.
- Memory grows by the size of the compiled bytecode kept in `/internal/shared/
  opcache` (MEMFS, inside the WASM heap). The 128 MiB `INITIAL_MEMORY` with
  `ALLOW_MEMORY_GROWTH` accommodates it, but the growth is why this stays
  experimental until measured.
- `opcache_reset()`/`opcache_invalidate()` remain no-ops; invalidation is the
  mtime check from ADR-0030. Reset Playground discards the WASM instance and
  with it the cache.

## Validation

- `tests/opcache.test.mjs` pins `isOpcacheEnabled()` (default off, config on,
  URL override both ways, falsy spellings) and `OPCACHE_SAPI_NAME === "uwsgi"`.
- `tests/omeka-versions.test.mjs` and `tests/shared-paths.test.mjs` pin the
  parameter parsing and its forwarding to `remote.html`.
- `tests/e2e/opcache-canary.spec.mjs` row `8.3:opcache` boots with `?opcache=1`
  and asserts `PHP_SAPI === "uwsgi"`, a live cache
  (`opcache_get_status().file_cache_only === true`) and that a rewritten file
  still recompiles (ADR-0030 holds with the cache active). The default `8.3`
  row asserts the cache stays inert and `PHP_SAPI === "wasm"` without the flag.
