# Omeka S runtime reference

Local details for the shared PHP-WASM and browser-runtime skills. Keep this file
outside installed skill directories; read the section needed for the task.

## PHP integration

- `src/runtime/php-loader.js` creates the runtime; `php-compat.js` adapts HTTP and
  tracks cookies. Use the existing request path for autologin.
- Initialize Omeka through bootstrap.php, not only vendor/autoload.php. The latter
  misses the patched Doctrine proxy loader. Modules may require continuation
  boots before their services/roles are available to subsequent provisioning.
- Keep the configured synchronous jobs and the spawn bridge's allowlist/recursion
  limit (`src/runtime/spawn-handler.js`); there are no native subprocesses.
  ImageMagick is unavailable; retain the configured GD/NoThumbnail behavior.
- The local dev server supplies the addon proxy; production uses the external
  proxy/allowlist. Test the affected path if outboundHttp or addonProxy settings
  change. Preserve archive/media path validation and API-write authentication.
- Retain scoped rewriting of HTML-escaped Omeka URLs, such as encoded /admin/site,
  under /omeka-s-playground. Verify autologin and saved login paths on reload.
- Domain provisioning: [omeka-s-internals](../skills/omeka-s-internals/SKILL.md).

## Storage and recovery

- Streaming tar.zst core lives at /www/omeka. Keep core extraction and the manifest
  in sync; see [bundle design](../../docs/streaming-tar-zst-bundle.md).
- `omeka-fs-journal:<scope>` journals /persist. The DB is
  /persist/mutable/db/omeka.sqlite, uploads /persist/mutable/files, and remote
  addons /persist/addons, linked into core modules/themes.
- OPcache is enabled during runtime but intentionally not journaled. Do not copy
  Nextcloud or FacturaScripts' OPcache persistence policy into Omeka.
- Keep /persist/runtime/content-seeded.json so ordinary reloads do not recreate
  edited/deleted demo content. Clean boot clears it with the mutable journal.
- For recovery changes, read php-worker.js, src/runtime/crash-recovery.js, and
  [ADR 0027](../../docs/architecture/adr/ADR-0027-selective-crash-recovery-snapshots.md).
  Preserve DB/upload checkpoint coherence, bounded snapshots, and failure fallback.
