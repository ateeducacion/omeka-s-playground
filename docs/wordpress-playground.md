# WordPress Playground-inspired model

## What WordPress Playground means here

This repository does **not** embed WordPress itself. Instead, it applies the same browser-executed PHP pattern popularized by WordPress Playground to **Omeka S**.

That means WordPress Playground matters here in two ways:

1. **Conceptually**: it is the reference architecture for browser-native PHP application bootstrapping.
2. **Practically**: it informs how this repository handles runtime setup, persistent state, blueprints, and contributor workflows.

If you know WordPress Playground already, the mental model is similar: a readonly application image is loaded into a browser-based PHP runtime, while mutable state is kept separately and can be rebuilt from a blueprint.

## How the project uses the Playground model

The runtime flow is:

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

The main WordPress Playground-style patterns are:

- **Browser PHP runtime** using `php-cgi-wasm`
- **Service-worker routing** so same-origin browser requests can be served by the in-browser PHP process
- **Readonly core + writable overlay** to avoid copying the whole application tree on every boot
- **Portable blueprint input** to describe initial state declaratively

## Initialization lifecycle

On a clean scope, the runtime:

1. loads the prebuilt Omeka bundle from `assets/omeka/`
2. mounts it under `/www/omeka`
3. prepares persistent writable storage under `/persist`
4. writes database and local configuration
5. installs Omeka if needed
6. applies the active blueprint
7. logs in automatically when `autologin` is enabled

On later reloads, the runtime reuses persisted state unless the bundle version or requested clean-boot conditions require a reset.

## What depends on the Playground model

The following areas depend directly on this architecture:

- `sw.js`: maps browser requests into the scoped runtime and rewrites HTML responses for the Pages subpath
- `php-worker.js`: owns the PHP worker lifecycle
- `src/runtime/bootstrap.js`: applies the blueprint and installs Omeka
- `src/runtime/vfs.js`: mounts the readonly bundle image
- `src/shared/blueprint.js`: normalizes blueprint input before boot

When contributors change any of those areas, they should think in Playground terms: immutable core, mutable overlay, and idempotent boot steps.

## Working locally and in the browser

### Local development

- Use `make serve` to start the local server.
- Use `make up` when you need the full dependency, prepare, bundle, and serve flow.
- Expect the local dev server to expose the addon proxy endpoint configured by `addonProxyPath`.

### Browser behavior

- Each scope gets its own persisted state.
- Importing a blueprint triggers a clean boot for that scope.
- The shell UI stores session state such as the active path and runtime selection.
- Runtime navigation happens inside the iframe, while the **Docs** menu entry opens published documentation in a separate tab.

## Constraints and caveats

These are the main project-specific constraints contributors should keep in mind:

- The public deployment runs under the GitHub Pages subpath `/omeka-s-playground`, not `/`.
- Omeka-generated HTML may contain escaped URLs, so routing and rewriting logic must stay conservative.
- Remote addon ZIP downloads often need the configured proxy because many upstream hosts do not provide CORS headers suitable for browser fetches.
- The project intentionally avoids copying the entire Omeka core into persistent storage; reintroducing that would hurt startup performance.
- Browser compatibility is focused on Chromium-class browsers first.

## Practical workflows

### Change demo content

Edit `assets/blueprints/default.blueprint.json`, then reload with a clean scope or reset the current scope.

### Debug install-time issues

Set `debug.enabled` to `true` in the blueprint, reproduce the clean boot, and inspect shell logs plus browser console output.

### Add a module or theme

Use the blueprint's `modules` or `themes` arrays and prefer stable, clearly named entries. For remote ZIPs, verify the URL will work with the configured proxy rules.

## Recommended habits

- Keep boot logic declarative through the blueprint whenever possible.
- Prefer small blueprint changes over hidden imperative install logic.
- Validate both first boot and reload behavior after changing runtime or routing code.
- Document any new assumptions in these docs at the same time as the code change.
