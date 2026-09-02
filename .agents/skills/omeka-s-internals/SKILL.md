---
name: omeka-s-internals
description: Omeka S domain expert for this php-wasm playground. Use when changing Omeka installation, services and APIs, modules or themes, sites, users, items, item sets, media, jobs, SQLite behavior, or Omeka-specific blueprint provisioning.
metadata:
  author: omeka-s-playground
  version: "1.0"
---

# Omeka S Internals

Use Omeka's own services and lifecycle while preserving the browser/WASM constraints proven in this repository. The local implementation is authoritative: start with `src/runtime/bootstrap.js`, `src/runtime/addons.js`, `docs/blueprint-json.md`, and `docs/development.md` rather than assuming a normal server install.

## Boot and installation

- Core lives at `/www/omeka`; mutable database, config, uploads, addons, and state live under `/persist` and are journaled per tab.
- SQLite is a file at `/persist/mutable/db/omeka.sqlite`. `buildDatabaseIni()` writes `driver = "pdo_sqlite"`; never use `:memory:` because each PHP request is a fresh lifecycle.
- Generated `local.config.php` owns playground-specific installer tasks, file paths, logging, thumbnailing, synchronous jobs, CLI execution, and media ingestion. Extend that configuration instead of patching unrelated core services.
- Installation scripts must require `/www/omeka/bootstrap.php` before initializing `Omeka\Mvc\Application`. Requiring only `vendor/autoload.php` bypasses Omeka's patched Doctrine proxy loader and can fail on proxy auto-generation mode `-1`.
- Check `Omeka\Status::isInstalled()` before running the installer. Keep install and later provisioning idempotent.

Useful services from the application service manager:

| Service | Purpose |
|---|---|
| `Omeka\ApiManager` | Search, create, read, and update resources |
| `Omeka\EntityManager` | Repository lookups and entity-only operations |
| `Omeka\AuthenticationService` | Establish the provisioning/admin identity |
| `Omeka\Settings` / `Omeka\Settings\User` | Global and per-user settings |
| `Omeka\ModuleManager` | Module discovery, install, and activation |
| `Omeka\Site\ThemeManager` | Theme discovery |

Prefer `ApiManager` for resources. Use Doctrine repositories for existence checks or operations the API does not expose. API response content supplies resource representations and IDs.

## Modules, themes, and jobs

- Modules live in `/www/omeka/modules/<Name>` and themes in `/www/omeka/themes/<Name>`. Remote addons are materialized under `/persist/addons` and mounted into those readonly-core locations.
- A module progresses through `STATE_NOT_INSTALLED` -> installed -> active. The bootstrap changes one state per pass, writes continuation state, and reruns so newly registered services, roles, and routes exist before later provisioning.
- Initialize an MVC controller context before module install hooks; hooks may use controller plugins such as URL and Messenger.
- Create blueprint users only after modules are active so module-defined roles validate correctly.
- Validate a requested theme through `ThemeManager`; only bundled-missing themes may fall back to `default`. A downloaded theme that remains missing is an installation error.
- Jobs use `Omeka\Job\DispatchStrategy\Synchronous`. The spawn bridge can run only allowlisted PHP commands inside the same WASM runtime; there are no real subprocesses or parallel jobs. Preserve the allowlist and recursion limit in `src/runtime/spawn-handler.js`.
- ImageMagick is unavailable. Use the configured GD thumbnailer when supported or `NoThumbnail`; do not shell out to `convert`.

## Resources and blueprint provisioning

- Omeka resource payloads use API terms such as `o:title`, `o:slug`, `o:theme`, and `o:is_public`.
- Metadata values require a property ID and value shape such as `['property_id' => $id, 'type' => 'literal', '@value' => $value]`. Resolve properties by term (for example `dcterms:title`) instead of hardcoding database IDs.
- Provision in dependency order: install -> modules/themes -> users -> sites/permissions -> vocabularies/properties -> item sets -> items -> media.
- Upsert users by email and sites by slug. Use partial API updates when preserving unspecified fields matters.
- Site permissions reference real user IDs and accepted site roles. Unknown users should produce a warning, not a broken relation.
- The first blueprint user is the effective admin identity. Keep a `global_admin` authenticated while provisioning protected resources.
- Content seeding is guarded by `/persist/runtime/content-seeded.json`, keyed to the bundle manifest. Do not reseed on ordinary reloads or deleted/edited demo content will reappear.
- Blueprint schema, normalization, and runtime consumption form one contract. Change `assets/blueprints/blueprint-schema.json`, `src/shared/blueprint.js`, runtime code, docs, and tests together.
- Browser REST reads can be public, but writes return 403 without API keys. Provision through the internal API manager or authenticated admin controllers; do not weaken Omeka authentication.

## SQLite and WASM constraints

- Keep the SQLite database as a persistent MEMFS file and preserve the readonly-core/mutable-overlay split.
- Audit addon SQL for MySQL-only statements. `src/runtime/easyadmin-patches.js` contains the proven EasyAdmin SQLite adaptations for indexes, table size, session cleanup, and table recreation.
- PHP outbound networking is controlled by the playground proxy/allowlist. Addon downloads occur browser-side; do not assume `file_get_contents()` or raw sockets can reach arbitrary hosts.
- Media URLs are downloaded into a cached playground file before Omeka's custom media ingester runs. Keep untrusted archive paths and media filenames validated.
- Each PHP execution is stateless apart from files, database, and sessions. Do not rely on PHP globals or open Doctrine connections surviving the next request.

## Verification

- [ ] Install completes from a clean scope and reload replays the journal without reinstalling.
- [ ] Modules reach the requested state across continuation boots; their roles/services exist before dependent resources.
- [ ] Sites, permissions, items, item sets, and media are idempotent and use Omeka APIs rather than direct SQL.
- [ ] SQLite receives no MySQL-only SQL and the DB remains `/persist/mutable/db/omeka.sqlite`.
- [ ] Jobs remain synchronous and spawned commands stay allowlisted.
- [ ] Schema, normalization, docs, and tests agree for blueprint changes.
- [ ] Admin navigation and public pages work through the scoped GitHub Pages subpath.
