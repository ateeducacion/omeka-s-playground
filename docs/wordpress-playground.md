# WordPress Playground-inspired model

## What WordPress Playground means here

This repository does **not** embed WordPress itself. Instead, it uses WordPress Playground's `@php-wasm/web` runtime to run **Omeka S** entirely in the browser.

That means WordPress Playground matters here in two ways:

1. **Conceptually**: it is the reference architecture for browser-native PHP application bootstrapping.
2. **Practically**: it provides the PHP WASM runtime, and informs how this repository handles runtime setup, ephemeral state, blueprints, and contributor workflows.

If you know WordPress Playground already, the mental model is similar: an application ZIP bundle is extracted into writable MEMFS, bootstrapped from a blueprint, and served through a service worker.

## How the project uses the Playground model

The runtime flow is:

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
                 -> src/runtime/vfs.js (ZIP extraction)
                 -> src/runtime/crash-recovery.js
```

The main WordPress Playground-style patterns are:

- **Browser PHP runtime** using `@php-wasm/web` and `@php-wasm/universal`
- **Multiple PHP versions** (8.1, 8.2, 8.3, 8.4, 8.5) selectable from the UI
- **Service-worker routing** so same-origin browser requests can be served by the in-browser PHP process
- **ZIP bundle extraction** into writable MEMFS at boot
- **Portable blueprint input** to describe initial state declaratively
- **Crash recovery** that snapshots DB and addons before WASM crashes

## Initialization lifecycle

On each page load, the runtime:

1. downloads and extracts the Omeka ZIP bundle from `assets/omeka/`
2. writes all files into `/www/omeka` in MEMFS
3. prepares writable directories under `/persist`
4. writes database and local configuration
5. installs Omeka if needed
6. applies the active blueprint
7. logs in automatically when `autologin` is enabled

All state is ephemeral — closing the tab destroys everything. Each page load boots a fresh instance.

## What depends on the Playground model

The following areas depend directly on this architecture:

- `sw.js`: maps browser requests into the scoped runtime and rewrites HTML responses for the Pages subpath
- `php-worker.js`: owns the PHP worker lifecycle and crash recovery
- `src/runtime/php-loader.js`: creates PHP runtime via `@php-wasm/web`
- `src/runtime/php-compat.js`: wraps the @php-wasm API for Omeka's bootstrap
- `src/runtime/bootstrap.js`: applies the blueprint and installs Omeka
- `src/runtime/vfs.js`: extracts the ZIP bundle into MEMFS
- `src/runtime/crash-recovery.js`: WASM crash detection, DB snapshot/restore
- `lib/omeka-loader.js`: downloads and caches the ZIP bundle
- `src/shared/blueprint.js`: normalizes blueprint input before boot

When contributors change any of those areas, they should think in Playground terms: ephemeral MEMFS, ZIP extraction, and idempotent boot steps.

## Working locally and in the browser

### Local development

- Use `make serve` to start the local server.
- Use `make up` when you need the full dependency, prepare, bundle, and serve flow.
- Expect the local dev server to expose the addon proxy endpoint configured by `addonProxyPath`.

### Browser behavior

- All state is ephemeral (MEMFS). Closing the tab destroys everything.
- Importing a blueprint triggers a clean boot.
- The shell UI stores session state such as the active path and runtime selection.
- The settings panel (⚙️) allows switching PHP versions.
- Runtime navigation happens inside the iframe, while **Home**, **Admin**, and **Docs** buttons are in the toolbar.

## Constraints and caveats

These are the main project-specific constraints contributors should keep in mind:

- The public deployment runs under the GitHub Pages subpath `/omeka-s-playground`, not `/`.
- Omeka-generated HTML may contain escaped URLs, so routing and rewriting logic must stay conservative.
- Remote addon ZIP downloads often need the configured proxy because many upstream hosts do not provide CORS headers suitable for browser fetches.
- Browser compatibility is focused on Chromium-class browsers first.
- The `@php-wasm` `__private__dont__use` API is used for low-level FS access; pin package versions.

## Practical workflows

### Change demo content

Edit `assets/blueprints/default.blueprint.json`, then reload with a clean scope or reset the current scope.

### Debug install-time issues

Set `debug.enabled` to `true` in the blueprint, reproduce the clean boot, and inspect shell logs plus the PHP Info tab.

### Add a module or theme

Use the blueprint's `modules` or `themes` arrays and prefer stable, clearly named entries. For remote ZIPs, verify the URL will work with the configured proxy rules.

## Recommended habits

- Keep boot logic declarative through the blueprint whenever possible.
- Prefer small blueprint changes over hidden imperative install logic.
- Validate both first boot and reload behavior after changing runtime or routing code.
- Document any new assumptions in these docs at the same time as the code change.
