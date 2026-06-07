<!--
MAINTENANCE: Update this file when:
- Adding/removing npm scripts in package.json or targets in Makefile
- Changing the runtime flow (shell, remote host, service worker, php worker, dev proxy server)
- Modifying the Omeka bundle format, manifest schema, or storage model
- Changing deployment assumptions for GitHub Pages or other static hosting
- Adding new conventions for blueprints, autologin, or persistent state
-->

# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

Omeka S Playground runs a full Omeka S instance entirely in the browser using WebAssembly.
It is inspired by WordPress Playground, but this repository is a much smaller static-site
application rather than a monorepo.

The project has five main layers:

1. Shell UI: `index.html` and `src/shell/main.js`
2. Runtime host: `remote.html` and `src/remote/main.js`
3. Request routing: `sw.js` and `php-worker.js`
4. PHP/Omeka runtime: `src/runtime/*` + generated assets under `assets/omeka/`
5. Local dev proxy server: `scripts/dev-server.mjs`

At runtime, the readonly Omeka core is loaded from a prebuilt bundle into memory, while
mutable state is stored separately in browser persistence.

## Build System

This project uses a small npm + Makefile workflow.

### Requirements

- Node.js 18+
- npm
- Composer
- Git

### Common Commands

```bash
# Install dependencies
npm install

# Prepare browser-side runtime assets
npm run sync-browser-deps
npm run prepare-runtime

# Build the Omeka bundle
npm run bundle

# End-to-end local workflow
make up

# Individual Make targets
make deps
make prepare
make bundle
make serve
make lint
make format
make test
make clean
make reset
```

### Important Scripts

- `npm run sync-browser-deps`: vendors browser runtime dependencies (fflate)
- `npm run prepare-runtime`: prepares the PHP runtime assets
- `npm run build-worker`: bundles php-worker.js via esbuild into `dist/php-worker.bundle.js`
- `npm run bundle`: fetches/builds Omeka for a single version (selected via the `OMEKA_VERSION` env var) and generates the readonly bundle + per-version manifest
- `make bundle-all`: builds bundles for every supported Omeka version
- `make serve`: runs the local Node dev server, including the addon proxy endpoint for remote blueprint ZIP downloads

### Supported Omeka versions

Supported versions are declared in `src/shared/omeka-versions.js` and consumed by:

- the build scripts (to select the git branch or release ZIP to fetch)
- the browser runtime (to pick the correct manifest URL at boot)
- the shell UI (to render the version dropdown in Settings)

Add a new version by appending an entry to `OMEKA_VERSIONS` (with a `source.type` of either `git` or `release-zip`) and adding a matching target in the `Makefile`.

### Generated Assets

- `assets/omeka/<version>/`: readonly runtime bundle files (`.zip`), one directory per supported Omeka version (e.g. `4.1.1`, `4.2.0`).
- `assets/manifests/<version>.json`: generated bundle manifest per Omeka version. `latest.json` is written for the default version as a backward-compat alias.
- `dist/`: esbuild-bundled worker and `@php-wasm` WASM binaries

Do not hand-edit generated bundle artifacts unless the task is specifically about the build output.

## Architecture

### Runtime Flow

The browser application is structured like this:

```text
index.html
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> php-worker.js (bundled via esbuild into dist/)
                 -> src/runtime/php-loader.js (@php-wasm/web)
                 -> src/runtime/php-compat.js (API wrapper)
                 -> src/runtime/bootstrap.js
                 -> src/runtime/vfs.js
                 -> src/runtime/crash-recovery.js
```

Responsibilities:

- `index.html` / `src/shell/main.js`
  - Toolbar, URL bar, iframe host, blueprint import, runtime status
- `remote.html` / `src/remote/main.js`
  - Registers the service worker and hosts the scoped playground iframe
- `sw.js`
  - Intercepts same-origin requests
  - Maps unscoped/static vs scoped/runtime requests
  - Rewrites redirects and HTML links for GitHub Pages subpaths
- `php-worker.js`
  - Owns the `@php-wasm` PHP instance for a scope
  - Boots Omeka and serves HTTP requests through the bridge
  - Applies the outbound HTTP policy
  - Handles crash recovery and runtime rotation
- `src/runtime/php-loader.js`
  - Creates the PHP runtime via `@php-wasm/web` loadWebRuntime
  - Deferred initialization pattern (call refresh() before use)
- `src/runtime/php-compat.js`
  - Wraps the raw `@php-wasm` PHP instance with the API expected by bootstrap/addons
  - Handles request/response conversion, cookie jar, static file serving
- `src/runtime/crash-recovery.js`
  - Detects fatal WASM errors (memory access, unreachable, resource exhaustion)
  - Snapshots DB/addon files before runtime destruction
  - Restores state onto fresh runtime
- `src/runtime/bootstrap.js`
  - Prepares storage
  - Installs Omeka when needed
  - Applies blueprint state
  - Handles autologin
- `src/runtime/vfs.js`
  - Mounts the readonly Omeka core bundle into the WASM filesystem
- `scripts/dev-server.mjs`
  - Serves the static app locally
  - Proxies remote addon ZIP downloads back to the same origin for browser runtime fetches
  - This proxy is local-only; production static hosting uses the external ZIP proxy configured in `playground.config.json`

### Storage Model

This project no longer copies the entire Omeka tree into persistent storage on every boot.

Current model (fully ephemeral — all state lives in Emscripten MEMFS):

- Readonly core: hydrated into in-memory FS under `/www/omeka`
- Mutable state: in-memory under `/persist` (not persisted to IndexedDB/OPFS)
- Remote blueprint addons: stored under `/persist/addons` and symlinked into `/www/omeka/modules` or `/www/omeka/themes` at boot
- Uploads: stored under `/persist/mutable/files`
- Database/config/session data: stored in the mutable overlay
- Crash recovery: DB and addon files are snapshotted from JS heap before runtime destruction and restored onto fresh runtimes

Closing the tab destroys all state. This is by design — fresh install on each page load.
Avoid reintroducing boot-time file-by-file copies of the full Omeka core into persistent storage.

### Bundle and Manifest

The Omeka bundle is built by the scripts in `scripts/`.

Relevant files:

- `scripts/build-omeka-bundle.sh`
- `scripts/generate-manifest.mjs`
- `lib/omeka-loader.js`
- `src/runtime/manifest.js`

If you change the bundle structure, also update manifest generation and runtime loading together.

## GitHub Pages and Base Path Handling

This project is deployed under a subpath:

- Production base path: `/omeka-s-playground`

That means absolute links like `/admin/site` are wrong in production unless they are rewritten
to the scoped runtime path.

### Important rule

When modifying `sw.js`, preserve all three behaviors:

1. App base path handling for static hosting in a subdirectory
2. Scoped runtime routing under `/playground/<scope>/<runtime>/...`
3. HTML response rewriting for Omeka-generated links and forms

Omeka can emit URLs HTML-escaped, for example:

```html
href="&#x2F;admin&#x2F;site"
```

The service worker must handle those cases. If navigation works on first load but breaks after
clicking inside the admin, inspect the HTML response body before assuming the routing layer is wrong.

## Blueprints

Blueprints are JSON files that describe the desired state of a playground instance.

Relevant files:

- `assets/blueprints/default.blueprint.json`
- `assets/blueprints/blueprint-schema.json`
- `src/shared/blueprint.js`

Blueprints can define:

- Site title, locale, timezone
- Debug mode for development-style error visibility
- Admin and other users
- Landing page
- Site creation
- Items, item sets, and media
- Modules and themes from bundled assets, direct ZIP URLs, or `omeka.org` slugs

Blueprint input can come from the default bundled file, `?blueprint=` URL fetches, or `?blueprint-data=` base64url JSON payloads.

When changing blueprint semantics, update both the schema and the runtime code that consumes it.

## Configuration

Runtime defaults live in:

- `playground.config.json`
- `src/shared/config.js`

Important flags include:

- `landingPath`
- `autologin`
- admin credentials and site defaults
- `outboundHttp`
- `addonProxyPath`
- `addonProxyUrl`

If you change autologin behavior, verify both first boot and reload behavior.
If you change `outboundHttp`, `addonProxyPath`, or `addonProxyUrl`, verify both local-dev proxy behavior and the production ZIP proxy flow.

## Development Conventions

### JavaScript

- The repo uses ESM. Keep imports/exports ESM-compatible.
- Prefer small, explicit helpers over deeply coupled inline logic.
- Keep browser code compatible with current Chromium-class browsers.
- Avoid introducing framework dependencies unless explicitly requested.

### Path Handling

- Be careful with URL paths versus filesystem paths.
- In service worker and shell code, prefer `URL` and explicit path helpers over ad-hoc string slicing.
- In runtime FS code, keep POSIX-style paths.

### Function Ordering

- Prefer caller before callee when adding related functions in the same file.
- Keep public/event-entry functions near the top of the local section.

### Comments

- Add comments only where logic is non-obvious.
- Keep comments short and focused on why the code exists, not what a line literally does.

## Linting, Formatting, and Testing

Before committing or submitting a PR, always run:

```bash
make lint      # Run Biome linter — must pass with zero errors
make format    # Auto-fix lint and formatting issues
make test      # Run unit tests — all must pass
```

Biome is configured in `biome.json` and checks `src/`, `tests/`, and `scripts/`. Fix any lint errors before committing. Use `make format` to auto-fix formatting and safe lint issues.

### Typical syntax checks

```bash
node --check src/shared/blueprint.js
node --check src/runtime/bootstrap.js
```

### Manual validation areas

- First boot install
- Reload behavior (fresh install each time — ephemeral)
- Autologin flow to `/admin`
- Navigation inside Omeka admin
- GitHub Pages subpath behavior
- Service worker updates after redeploy

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.

## Key Files

- `index.html`: shell UI
- `remote.html`: runtime host page
- `sw.js`: service worker routing and HTML/link rewriting
- `php-worker.js`: PHP worker bridge, boot lifecycle, and crash recovery
- `src/runtime/php-loader.js`: creates PHP runtime via `@php-wasm/web`
- `src/runtime/php-compat.js`: wraps `@php-wasm` API for compatibility with bootstrap/addons
- `src/runtime/crash-recovery.js`: WASM crash detection, DB snapshot/restore
- `playground.config.json`: runtime defaults
- `src/runtime/bootstrap.js`: installation, config, blueprint application, autologin
- `src/runtime/vfs.js`: readonly core bundle mounting
- `src/runtime/manifest.js`: manifest loading
- `src/shared/protocol.js`: shell/worker protocol definitions
- `src/shared/storage.js`: browser persistence helpers
- `src/styles/app.css`: shell styling
- `scripts/esbuild.worker.mjs`: bundles php-worker.js into dist/
- `Makefile`: common local workflow

## Common Pitfalls

- Do not assume the app is hosted at `/`; production runs in a subdirectory.
- Do not assume Omeka-generated links are plain text; some are HTML-escaped.
- Do not assume PHP can open raw sockets to the internet; outbound HTTP flows through the browser's fetch API and the configured allowlist/proxy policy.
- Do not move the entire core into persistent storage unless explicitly required.
- Do not break the separation between readonly core and mutable overlay.
- Do not forget that service worker changes often require a hard refresh or worker reset to verify.
- Do not rely on stale shell state if `autologin` is enabled; saved `/login` paths may need to be ignored.

## When Editing Specific Areas

### If you edit `sw.js`

- Re-check path scoping for both local root hosting and GitHub Pages subpath hosting
- Validate redirect rewriting and HTML attribute rewriting together
- Be conservative with external URLs and special schemes

### If you edit `bootstrap.js`

- Verify install idempotency
- Verify persisted data survives reloads
- Verify autologin does not block startup when credentials fail

### If you edit bundle scripts

- Keep the manifest schema and runtime readers in sync
- Avoid changing output file names casually; deployment and loaders depend on them

## Deployment Notes

The project is intended for static deployment, especially GitHub Pages.

After changes to `sw.js`, `remote.html`, or runtime boot files:

- redeploy the site
- force-refresh the browser or clear the old service worker
- verify from a clean scope when possible

## Reference Projects

- WordPress Playground: architectural inspiration
- Moodle Playground: bundle/build pipeline inspiration

Use those as references, but prefer the actual conventions in this repository when they differ.

## Debugging

### By hand (in the browser)

Serve the static app locally and open it in a Chromium-class browser:

```bash
make serve                 # PORT=8080 node ./scripts/dev-server.mjs (default)
PORT=8087 make serve       # pick another port
PORT=8087 node ./scripts/dev-server.mjs   # the same thing, directly
```

Then open `http://localhost:<port>/`. The dev server binds to `127.0.0.1`; a
privileged port below `1024` fails with `EACCES`, so use something like `8087`.

**Scoped routing.** The shell at `/` (`index.html` + `src/shell/main.js`) boots a
Web Worker (`php-worker.js`, the PHP/WASM runtime) and a Service Worker (`sw.js`).
The actual Omeka app is then served under `/playground/<scope>/<runtime>/…` and
displayed inside the `#site-frame` iframe. `<runtime>` is a runtime id such as
`php83-omeka420` (see `playground.config.json`); `<scope>` is a per-tab id stored
in `sessionStorage` (`getOrCreateScopeId` in `src/shared/storage.js`), so all
mutable state is scoped to that tab within its session.

**Detecting "boot ready".** Boot is slow (the readonly core is extracted into the
WASM filesystem before the installer runs), so poll rather than assume. The shell
sets the `#site-frame` src to `remote.html?scope=<id>&runtime=<id>&path=…` and
keeps `#address-input` disabled until the runtime is up. Boot is ready when
`#address-input` is enabled and `#site-frame`'s `src` contains `scope=`:

```js
const ready = () =>
  !document.querySelector("#address-input").disabled &&
  /scope=/.test(document.querySelector("#site-frame").getAttribute("src") || "");
```

**Dumping the persistence journal.** Mutable `/persist` state (SQLite DB, uploads,
config, the content-seeded marker) is journaled to IndexedDB by
`src/runtime/fs-persistence.js`. The database name is
`omeka-fs-journal:<scopeId>` and the operations live in the `ops` object store.
Run this in the *page* console (the shell document, not the iframe):

```js
(async () => {
  const dbs = await indexedDB.databases();
  const name = dbs.map((d) => d.name).find((n) => n?.startsWith("omeka-fs-journal:"));
  if (!name) return console.warn("no journal db yet — has it booted?");
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const ops = await new Promise((res, rej) => {
    const r = db.transaction("ops", "readonly").objectStore("ops").getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  console.log(name, ops.length, ops);
})();
```

**App recipes (run from the page console).** Derive the scoped base path from the
iframe, then talk to Omeka directly:

```js
const src = document.querySelector("#site-frame").getAttribute("src");
const base = decodeURIComponent(new URL(src, location).searchParams.get("path") || "/");
// or read it straight off the scoped path:
const scoped = "/playground/" +
  new URL(src, location).searchParams.get("scope") + "/" +
  new URL(src, location).searchParams.get("runtime");
```

- **Public read (no auth):** `GET ${scoped}/api/items?per_page=100` returns the
  items as JSON-LD. This works unauthenticated.
- **Admin session:** autologin (`autologin: true` in `playground.config.json`,
  performed in `src/runtime/bootstrap.js`) means the admin session is already
  active. `GET ${scoped}/admin` shows the dashboard; `${scoped}/logout` ends it.
- **API WRITES return 403.** The Omeka REST API rejects writes without API keys,
  and the playground does not provision keys. To mutate data, drive the admin
  controllers instead. To delete items, POST to the admin batch-delete endpoint:

  ```
  POST ${scoped}/admin/item/batch-delete?...
  fields:
    <csrf-name>      # the hidden CSRF field from the batch-delete <form> on /admin/item
    resource_ids[]   # one per item id to delete
  ```

  Read the CSRF field name and value out of the batch-delete form on the
  `${scoped}/admin/item` browse page first (Omeka names it like
  `batch_delete_selected_csrf`); the token is request-scoped, so fetch the page
  and reuse the token from the same response.

**Reset.** The `#reset-button` (handler in `src/shell/main.js`) triggers a clean
boot (`?clean=1`), which calls `clearJournal(scopeId)` in
`src/runtime/fs-persistence.js` to wipe the `/persist` journal — including the
`/persist/runtime/content-seeded.json` marker, so blueprint content reseeds on
the next boot.

**Admin credentials:** `admin` / `password`, email `admin@example.com` (from the
`admin` block in `playground.config.json`).

### With the e2e suite (Playwright)

End-to-end tests live in `tests/e2e/*.spec.mjs` and run with Playwright:

```bash
npm run test:e2e     # = playwright test
npx playwright test  # equivalent
make test-e2e        # wraps npm run test:e2e
```

Config is in `playwright.config.mjs`: tests run serially (`fullyParallel: false`)
against `http://127.0.0.1:8085`, and the `webServer` block builds the bundle if
needed then runs `make serve` on port `8085`.

`shell.spec.mjs` covers the persistence round-trip: boot → confirm an
`omeka-fs-journal:<scopeId>` IndexedDB exists → wait past the 1500ms debounced
flush → reload in the same tab (sessionStorage keeps the scope) → the runtime
reboots by replaying the journal instead of doing a clean install.

Gotchas:

- **Run each sibling playground's e2e on its own.** `webServer.reuseExistingServer`
  is enabled outside CI, and the sibling PHP-WASM playgrounds share a dev-server
  port. Concurrent Playwright runs across the sibling repos reuse each other's
  server and cross-contaminate — one repo's tests end up hitting another app's
  shell. Run them one repo at a time (or give each its own port / set
  `PLAYWRIGHT_BASE_URL` + `PLAYWRIGHT_EXTERNAL_SERVER=1`).
- **A full `page.reload()` can hang on the `load` event.** On reload the shell
  promotes the scoped WASM app to the top window, so the `load` event may never
  settle. Reload with `await page.reload({ waitUntil: "commit" })` and then poll
  for readiness (`#address-input` enabled and `#site-frame` src containing
  `scope=`) instead of waiting for `load`.

## Persistence model (per-tab storage + blueprint reset)

Mutable state under `/persist` is journaled to IndexedDB (`omeka-fs-journal:<scope>`) via
`@php-wasm/fs-journal`, so it survives reloads. Key facts for future work:

- **Per-tab, within-session.** `scopeId` lives in `sessionStorage`, so each
  browser tab/window has its own environment. Opening the playground in a new tab
  starts clean — nothing is shared (only *duplicating* a tab copies
  `sessionStorage`). State is lost when the tab closes.
- **A different blueprint starts fresh.** The persisted env is keyed by the
  blueprint *source* — `blueprintSourceKey(href)` in `src/shared/paths.js`
  (`url:<value>` for `?blueprint-url=`, `inline:<hash>` for `?blueprint=` /
  `?blueprint-data=`, else `default`) — remembered per scope in `sessionStorage`
  (`blueprint-source:<scope>`). Loading a **different** blueprint in the same tab
  forces a clean boot (discards the previous `/persist` and installs fresh);
  **reloading the same blueprint keeps the data.** (Same intent as WordPress
  Playground, which serves URL blueprints as temporary by default and keys
  persisted sites per site-slug.)
- **Clean boot wiring.** On a clean boot the shell adds `&clean=1` to the
  `#site-frame` remote URL; the worker then `clearJournal`s and **re-starts
  journaling** (`initFsPersistence` runs after the clear in
  `src/runtime/php-loader.js`) so the fresh env persists on later reloads. The
  `#reset-button` triggers the same path.
- **Flush.** On each debounced flush the journal collapses ops *before* hydrating
  (`collapseAndHydrate` = `hydrateUpdateFileOps(php, normalizeFilesystemOperations(ops))`)
  so a heavy install that rewrites the SQLite DB hundreds of times doesn't OOM.
- **Inspect:** `await indexedDB.databases()` → open `omeka-fs-journal:<scope>` → read the
  `ops` object store.
