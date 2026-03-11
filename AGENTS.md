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
make clean
make reset
```

### Important Scripts

- `npm run sync-browser-deps`: vendors browser runtime dependencies
- `npm run prepare-runtime`: prepares the PHP runtime assets
- `npm run bundle`: fetches/builds Omeka and generates the readonly bundle
- `make serve`: runs the local Node dev server, including the addon proxy endpoint for remote blueprint ZIP downloads

### Generated Assets

- `assets/omeka/`: readonly runtime bundle files (`.vfs.bin`, index, metadata)
- `assets/manifests/`: generated bundle manifests

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
              -> php-worker.js
                 -> src/runtime/bootstrap.js
                 -> src/runtime/vfs.js
                 -> php-cgi-wasm
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
  - Owns the `php-cgi-wasm` instance for a scope
  - Boots Omeka and serves HTTP requests through the bridge
  - Applies the outbound HTTP policy used by VRZNO-backed `http`/`https` PHP stream access
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

Current model:

- Readonly core: hydrated into in-memory FS under `/www/omeka`
- Mutable state: persisted under `/persist`
- Remote blueprint addons: persisted under `/persist/addons` and symlinked into `/www/omeka/modules` or `/www/omeka/themes` at boot
- Uploads: stored under `/persist/mutable/files`
- Database/config/session data: stored in the persistent overlay

This split is intentional and is one of the main performance optimizations in the repo.
Avoid reintroducing boot-time file-by-file copies of the full Omeka core into IndexedDB.

### Bundle and Manifest

The Omeka bundle is built by the scripts in `scripts/`.

Relevant files:

- `scripts/build-omeka-bundle.sh`
- `scripts/build-vfs-image.mjs`
- `scripts/generate-manifest.mjs`
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

## Testing and Verification

There is no large formal test suite in this repository today. Verification is mostly targeted.

### Typical checks

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
node --check src/shell/main.js
```

### Manual validation areas

- First boot install
- Reload with persisted state
- Autologin flow to `/admin`
- Navigation inside Omeka admin
- GitHub Pages subpath behavior
- Service worker updates after redeploy

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.

## Key Files

- `index.html`: shell UI
- `remote.html`: runtime host page
- `sw.js`: service worker routing and HTML/link rewriting
- `php-worker.js`: PHP worker bridge and boot lifecycle
- `playground.config.json`: runtime defaults
- `src/runtime/bootstrap.js`: installation, config, blueprint application, autologin
- `src/runtime/vfs.js`: readonly core bundle mounting
- `src/runtime/manifest.js`: manifest loading
- `src/shared/protocol.js`: shell/worker protocol definitions
- `src/shared/storage.js`: browser persistence helpers
- `src/styles/app.css`: shell styling
- `Makefile`: common local workflow

## Common Pitfalls

- Do not assume the app is hosted at `/`; production runs in a subdirectory.
- Do not assume Omeka-generated links are plain text; some are HTML-escaped.
- Do not assume PHP can open raw sockets to the internet; outbound HTTP is expected to flow through VRZNO/fetch and the configured allowlist/proxy policy.
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
