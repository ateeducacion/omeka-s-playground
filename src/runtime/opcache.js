// OPcache configuration shared by the request and CLI runtimes.
// See docs/architecture/adr/ADR-0030-opcache-file-cache-timestamp-validation.md
// and docs/architecture/adr/ADR-0031-experimental-opcache-via-sapi-name.md.

// Scripts OPcache must never cache. php.run({ code }) writes every snippet to
// the same /internal/eval.php, so a stored .bin would be served for a later,
// different snippet. The blacklist is honoured on store in file-cache-only mode.
export const OPCACHE_BLACKLIST_PATH = "/internal/shared/opcache-blacklist.txt";
export const OPCACHE_BLACKLIST = "/internal/eval.php\n";

// Compiled bytecode is kept in /internal/shared/opcache (file cache only, no
// shared memory segment). Timestamps ARE validated: PHP <= 8.4 never starts
// OPcache under the `wasm` SAPI, but PHP 8.5 dropped the SAPI whitelist and
// runs this cache for real, and PHP files do change within a session (module
// and theme installs, blueprint files). In file-cache-only mode
// opcache_reset() and opcache_invalidate() are no-ops, so the mtime check
// (whole seconds, with PHP's default 2 s file_update_protection) is the only
// invalidation. max_accelerated_files / memory_consumption /
// interned_strings_buffer are inert without shared memory; kept for phpinfo.
export const OPCACHE_INI_ENTRIES = {
  "opcache.enable": "1",
  "opcache.file_cache": "/internal/shared/opcache",
  "opcache.file_cache_only": "1",
  "opcache.max_accelerated_files": "10000",
  "opcache.memory_consumption": "96",
  "opcache.interned_strings_buffer": "16",
  "opcache.jit": "0",
  "opcache.validate_timestamps": "1",
  "opcache.revalidate_freq": "0",
  "opcache.blacklist_filename": OPCACHE_BLACKLIST_PATH,
  "opcache.file_cache_consistency_checks": "0",
};

/**
 * Write the blacklist file PHP reads at startup. Must run before the first
 * request of every runtime (request, CLI, hot-swapped).
 */
export function writeOpcacheBlacklist(php, FS) {
  try {
    FS.mkdirTree("/internal/shared");
  } catch {
    /* exists */
  }
  php.writeFile(OPCACHE_BLACKLIST_PATH, OPCACHE_BLACKLIST);
}

// OPcache activation (ADR-0031, on by default since ADR-0035). php-src <= 8.4
// only starts OPcache for whitelisted SAPI names; `uwsgi` is on that list and
// nothing in Omeka S 4.2.1 or its vendor tree branches on it (the only SAPI
// checks are `PHP_SAPI === 'cli'`, which `uwsgi` fails exactly like `wasm`
// does).
// Reported to PHP as php_sapi_name(); php-wasm itself ignores the value.
export const OPCACHE_SAPI_NAME = "uwsgi";

/**
 * Decide whether to switch the SAPI name so OPcache's file cache starts.
 * `?opcache=1|0` overrides `playground.config.json`'s `opcache` key (shipped
 * as true, ADR-0035; off when the key is missing). PHP 8.5 runs the cache
 * regardless; the flag only matters for <= 8.4.
 */
export function isOpcacheEnabled(param, config = {}) {
  if (param !== null && param !== undefined && param !== "") {
    return !["0", "false", "off", "no"].includes(String(param).toLowerCase());
  }
  return config.opcache === true;
}

/**
 * URL `opcache` value that makes isOpcacheEnabled() return `enabled` against
 * this config: null when the config default already does (keeps the URL clean).
 * Used by the info panel toggle (ADR-0032).
 */
export function opcacheUrlParam(enabled, config = {}) {
  if (enabled === (config.opcache === true)) {
    return null;
  }
  return enabled ? "1" : "0";
}
