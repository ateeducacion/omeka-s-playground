<!--
MAINTENANCE: Update this file when:
- Adding/removing npm scripts in package.json or targets in the Makefile
- Changing the runtime flow (shell, remote host, service worker, php worker, dev proxy server)
- Changing the persistence model (paths under /persist, the IndexedDB journal, the seed marker)
- Modifying the Omeka bundle format, manifest schema, or storage model
- Changing the scoped URL routing scheme or the GitHub Pages base path
- Changing CI (workflows, test commands, vendored vs. bare-specifier deps)
-->

# AGENTS.md

Debugging and development guide for the **Omeka S Playground** — a full Omeka S
instance that runs entirely in the browser on PHP-WASM. This file is written for
AI agents and humans doing day-to-day work on the playground. It is one of four
sibling PHP-WASM playgrounds (Nextcloud, Moodle, Omeka, FacturaScripts) that
share the same architecture; details below are verified against *this* repo.

## Overview / Architecture

The browser app is layered:

```text
index.html              shell UI (toolbar, address bar, #site-frame, settings)
  └─ src/shell/main.js
       └─ remote.html    runtime host page (registers SW, hosts the scoped iframe)
            └─ src/remote/main.js
                 └─ sw.js                 service worker: intercepts same-origin
                      └─ php-worker.js     the worker — owns the PHP instance
                           ├─ src/runtime/*   php-loader, php-compat, bootstrap,
                           │                   vfs, fs-persistence, crash-recovery,
                           │                   addons, manifest, cli-runtime …
                           ├─ src/shared/*    config, blueprint, paths, protocol,
                           │                   omeka-versions, storage …
                           └─ lib/omeka-loader.js   manifest + bundle fetch/unzip
```

Key facts:

- **Blueprint-driven provisioning.** A JSON blueprint (default
  `assets/blueprints/default.blueprint.json`, overridable via `?blueprint=`,
  `?blueprint-url=`, or base64url `?blueprint-data=`) describes the desired
  state: users, sites, items, item sets, media, modules, themes. `bootstrap.js`
  generates a PHP install script from it.
- **esbuild-bundled worker.** `php-worker.js` is bundled to
  `dist/php-worker.bundle.js` by `scripts/esbuild.worker.mjs`. The `@php-wasm`
  WASM binaries and ICU data are emitted into `dist/` too.
- **Readonly core + mutable overlay.** The Omeka core is mounted readonly into
  the WASM FS under `/www/omeka` from a prebuilt ZIP bundle; all mutable state
  lives under `/persist` and is journaled to IndexedDB (see Persistence model).
- **`@php-wasm/*` pinned at `^3.1.36`** in `package.json` (`@php-wasm/web`,
  `@php-wasm/universal`, `@php-wasm/fs-journal`, `@php-wasm/stream-compression`),
  plus `fflate ^0.8.3`. Lint is **Biome** (`biome.json`). Common targets:
  `make test` / `make lint` / `make bundle`.

## Running locally

The dev server is a tiny static server with an add-on ZIP proxy:

```bash
PORT=8087 node ./scripts/dev-server.mjs
# or via the Makefile target:
make serve PORT=8087
```

CRITICAL gotchas:

- The server binds to `process.env.PORT` (the Makefile passes `PORT=$(PORT)`,
  default `8080`). A **privileged port (<1024) fails with `EACCES`** — always
  use a high port, e.g. `8087`.
- `dist/php-worker.bundle.js` and `index.html` **must exist** before the app
  boots. If `dist/` is missing or stale, run **`make bundle`** first (which runs
  `prepare` → `sync-browser-deps` + `prepare-runtime` + `build-worker`, then
  builds the Omeka bundle). To only rebuild the worker after a source change:
  `npm run build-worker`.
- The dev server also serves `/__addon_proxy__?url=<encoded>` so the browser can
  fetch remote add-on ZIPs same-origin (it falls back to `curl` when Node fetch
  is TLS-fingerprint-blocked). In production the external proxy in
  `playground.config.json` (`addonProxyUrl`) is used instead.

Full build matrix: `make bundle-all` builds every supported Omeka version;
`make up` is `bundle-all` + `serve`.

## Scoped URL routing

The shell lives at `/`. Verify the rest by booting and reading the live DOM.

- The shell renders `#site-frame` whose `src` is
  `remote.html?scope=<scopeId>&runtime=<runtimeId>&path=<path>`
  (built by `resolveRemoteUrl` in `src/shared/paths.js`).
- Inside `remote.html`, a **nested iframe** (`#remote-frame`) points at the real
  scoped app path:
  **`/playground/<scopeId>/<runtimeId><path>`**
  (built by `buildScopedSitePath` in `src/shared/paths.js`).
- `runtimeId` looks like **`php83-omeka420`** (`php<XY>-omeka<NNN>`, parsed by
  `parseRuntimeId` in `src/shared/omeka-versions.js`). Default is
  `php83-omeka420` (PHP 8.3 + Omeka S 4.2.0); `php83-omeka411` is also bundled.
- `scopeId` is a `crypto.randomUUID()` minted by `getOrCreateScopeId`
  (`src/shared/storage.js`) and stored in **sessionStorage**. It can also come
  from a `?scope=` query param.
- `sw.js` distinguishes unscoped/static requests from scoped/runtime requests,
  rewrites redirects, and rewrites Omeka-generated HTML links/forms for the
  GitHub Pages subpath (`/omeka-s-playground` in production). Omeka sometimes
  emits HTML-escaped URLs (e.g. `href="&#x2F;admin&#x2F;site"`) — the SW handles
  those. If navigation works on first load but breaks after clicking inside the
  admin, inspect the HTML response body before blaming the routing layer.

## Boot & readiness

Boot is **slow** — the PHP-WASM runtime loads (~20 MB WASM + ~30 MB ICU) and the
Omeka core (~19 MB ZIP, ~9 300 files) is extracted into MEMFS via PHP's native
`ZipArchive`. Expect roughly **10–40 s**. Browser-automation navigation tools
often time out while boot is still progressing — **boot continues; poll for
readiness** instead of trusting a navigation timeout.

Readiness signals (this is what the e2e test waits on,
`tests/e2e/shell.spec.mjs`):

- `#address-input` becomes **enabled**, and
- `#site-frame`'s `src` attribute **contains `scope=`**.

Progress is reported through a `BroadcastChannel` to the shell (`kind: "progress"`
/ `"ready"` / `"error"` messages from `php-worker.js`).

## Persistence model (Wave 4)

Mutable state is journaled to **IndexedDB** via `@php-wasm/fs-journal`
(`src/runtime/fs-persistence.js`), keyed by `scopeId`.

- IndexedDB database name: **`omeka-fs-journal:<scopeId>`**
  (prefix `omeka-fs-journal`, store name `ops`, debounced flush every 1500 ms).
- Because `scopeId` is **sessionStorage**-based, persistence has *within-session
  durability*: it **survives reloads and navigations within the same tab**, but
  is lost when the tab closes (a new tab mints a new `scopeId` → fresh install).
- On boot, `php-loader.js` replays the saved journal onto the fresh PHP instance
  **before** Omeka bootstraps, so `$status->isInstalled()` finds the restored DB
  and skips reinstall. Replay is resilient: a single un-appliable op (e.g. a
  dangling `unlink` from media created in the isolated CLI runtime) is skipped
  rather than bricking the reload.
- Only `/persist` is journaled. Ephemeral SQLite sidecars
  (`.sqlite-journal` / `.sqlite-wal` / `.sqlite-shm`) are skipped. OPcache is
  intentionally **not** journaled.

What lives under `/persist` (constants at the top of `src/runtime/bootstrap.js`):

| Path | What |
| --- | --- |
| `/persist/mutable/db/omeka.sqlite` | the Omeka SQLite database |
| `/persist/mutable/config/playground-state.json` | install/manifest/blueprint state |
| `/persist/mutable/config/playground-prepend.php` | generated `auto_prepend_file` |
| `/persist/mutable/files` | uploaded media (symlinked to `/www/omeka/files`) |
| `/persist/mutable/session` | PHP session save path |
| `/persist/mutable/logs` | logs |
| `/persist/addons` | persisted add-on (module/theme) files |
| `/persist/runtime/blueprint-media` | prefetched blueprint media files |
| `/persist/runtime/content-seeded.json` | content-seed marker (see below) |

**Reset / clean boot.** The `#reset-button` triggers a clean boot
(`pendingCleanBoot = true` → `remote.html?...&clean=1`). `remote/main.js` reads
`clean=1` and sends it to the worker, which calls `clearJournal(scopeId)`
(wiping `omeka-fs-journal:<scopeId>`) and then re-installs from scratch. Note the
top-window `/` URL does **not** read a bare `?clean=1`; the clean flag is carried
on the *remote.html* URL, set by the reset button (or a blueprint URL override).

### Persist DATA, not caches (the general lesson)

Blueprint **content** (items + item sets) is seeded only **once**, guarded by the
marker `/persist/runtime/content-seeded.json` keyed by the bundle/manifest
signature (`buildInstallScript` in `src/runtime/bootstrap.js`). On later reloads
the seed loops are skipped, so a user who deletes or edits a seeded item keeps
that change. A **manifest change** (new signature) or a **reset** (which wipes
`/persist`, removing the marker) reseeds. Sibling note: Moodle excludes
`/persist/moodledata/(cache|localcache|temp|muc)` from journaling — same
principle, persist real data, never caches.

## Debugging recipes

Run all of these **from the page console**. They use `await` at top level (paste
into DevTools, which supports it).

### Inspect the IndexedDB journal

```js
// 1. Find the journal DB(s) for the current scope.
(await indexedDB.databases()).filter(d => d.name?.startsWith("omeka-fs-journal:"))

// 2. Open it and dump the journaled ops (each op is {path, operation, ...}).
//    The scope is most reliably read from the #site-frame src params; the active
//    scopeId is also in sessionStorage under "omeka-playground:active".
await new Promise((resolve) => {
  const scope = new URL(document.querySelector("#site-frame").src).searchParams.get("scope");
  const req = indexedDB.open("omeka-fs-journal:" + scope);
  req.onsuccess = () => {
    const tx = req.result.transaction("ops", "readonly");
    const all = tx.objectStore("ops").getAll();
    all.onsuccess = () => { console.table(all.result.map(o => ({ path: o.path, operation: o.operation }))); resolve(all.result); };
  };
});
```

### Derive the app base URL, then talk to Omeka

```js
// Base = /playground/<scope>/<runtime> — read it from the site-frame src params.
const p = new URL(document.querySelector("#site-frame").src).searchParams;
const base = `/playground/${p.get("scope")}/${p.get("runtime")}`;
```

**Admin / auth quirk.** The playground holds an admin session **server-side**
(autologin runs at boot, credentials from `playground.config.json`:
`admin` / `password` / `admin@example.com`). So fetching the admin dashboard with
just the session cookie works — no login form:

```js
const html = await (await fetch(`${base}/admin`)).text();
html.includes("/logout"); // true → you are the logged-in admin
```

**API reads (unauthenticated) work.** The Omeka REST API returns JSON-LD for
public resources without keys:

```js
const items = await (await fetch(`${base}/api/items?per_page=100`)).json();
```

**API writes do NOT work with only a session cookie.** `DELETE`/`POST /api/...`
require API keys and otherwise return
`403 "Permission denied for the current user"`. Use the **admin controller
actions** instead. Example — batch-delete items (read the CSRF token from the
batch-delete form on the `/admin/item` browse page, then post it):

```js
const browse = await (await fetch(`${base}/admin/item`)).text();
const csrf = browse.match(/name="(confirmform_csrf|csrf)"[^>]*value="([^"]*)"/)[2];
const body = new URLSearchParams();
body.set("confirmform_csrf", csrf);
for (const id of [1, 2, 3]) body.append("resource_ids[]", String(id));
await fetch(`${base}/admin/item/batch-delete`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: body.toString(),
});
```

### Capture phpinfo / runtime diagnostics

The shell has a phpinfo tab; programmatically the worker responds to a
`capture-phpinfo` message and there is a SQLite probe at boot
(`buildProbeScript` in `bootstrap.js`). If boot fails with a SQLite error, that
probe output is the first thing to read.

## Build & test

```bash
make lint     # Biome check — must pass with zero errors
make format   # Biome check --fix (auto-fix)
make test     # node --test tests/*.test.mjs
make bundle   # prepare + build the default Omeka bundle (also: npm run build-worker)
make test-e2e # Playwright (npm run test:e2e)
```

Notes:

- **Biome auto-wraps long lines.** Match its formatting (run `make format`) or
  `make lint` fails on style.
- After a source change, confirm it actually reached the worker bundle:
  `grep <token> dist/php-worker.bundle.js`.
- Unit tests are `node --test tests/*.test.mjs`. e2e is Playwright
  (`tests/e2e/*.spec.mjs`, `playwright.config.mjs`; default base URL
  `http://127.0.0.1:8085`, its `webServer` runs `make serve` on `PORT=8085`,
  building the bundle first if `assets/manifests/latest.json` is absent).

## CI gotchas

- **CI runs `make test` WITHOUT `sync-browser-deps`**, so `vendor/` is absent
  (it is gitignored, populated only by `npm run sync-browser-deps`). Therefore
  import shared deps as **bare specifiers** (`fflate`, `@php-wasm/...`), **not**
  `../vendor/...`, or the loader tests break. See `lib/omeka-loader.js` for the
  correct pattern.
- **Never `git add -A`.** It would commit local `.claude/` / `.omc/` artifacts.
  Stage explicit files only.
- **CodeQL / least privilege:** workflows set `permissions: contents: read`
  (`.github/workflows/ci.yml`). Keep that — don't widen token scope.
- **Two CI jobs** in `ci.yml`: `test` (syntax check + `make test` + `make lint`)
  and `e2e` (Playwright boot smoke that builds the default bundle: git clone +
  composer + runtime, then asserts the runtime boots). `pages.yml` deploys to
  GitHub Pages and builds **all** Omeka versions.

## Common pitfalls

- Don't assume the app is hosted at `/`; production runs under
  `/omeka-s-playground`. Use `URL` and the helpers in `src/shared/paths.js`.
- Don't assume Omeka links are plain text; some are HTML-escaped.
- Don't move the whole core into persistent storage, and don't break the
  readonly-core / mutable-overlay separation.
- Service-worker changes often need a hard refresh or worker reset to take
  effect — verify from a clean scope when in doubt.
- PHP can't open raw sockets; outbound HTTP goes through `fetch` and the
  configured proxy/allowlist policy.
