# Omeka S Playground

<p align="center">
  <img src="../ogimage.png" alt="Omeka S Playground" width="600">
</p>

Omeka S Playground runs a full Omeka S 4.2.0 instance in the browser with WebAssembly, powered by [WordPress Playground](https://github.com/WordPress/wordpress-playground)'s `@php-wasm/web` runtime. No server required — every page load boots a fresh, ephemeral Omeka S instance.

Use this documentation when you need to:

- understand how the browser runtime is assembled
- work safely with the default `blueprint.json`
- extend the project without breaking the ephemeral MEMFS model
- understand how the GitHub Pages deployment publishes both the app and these docs

## Start here

- [Getting started](getting-started.md) for local setup, key files, and preview commands
- [WordPress Playground](wordpress-playground.md) for the execution model and project-specific constraints
- [`blueprint.json`](blueprint-json.md) for the schema, examples, validation steps, and maintenance guidance
- [Development](development.md) for contributor workflows and docs publishing

## What this project does

The application has five layers:

1. **Shell UI** in `index.html` and `src/shell/main.js`
2. **Runtime host** in `remote.html` and `src/remote/main.js`
3. **Request routing** in `sw.js` and `php-worker.js` (bundled via esbuild into `dist/`)
4. **Omeka runtime boot** in `src/runtime/*` (php-loader, php-compat, bootstrap, crash-recovery)
5. **Local development proxy** in `scripts/dev-server.mjs`

At runtime:

- the Omeka core is extracted from a ZIP bundle into writable MEMFS under `/www/omeka`
- mutable state (SQLite database, config, uploads) lives under `/persist` in MEMFS
- all state is ephemeral — closing the tab destroys everything
- the shell hosts the running site in an iframe and exposes Home, Admin, and Docs navigation
- the service worker rewrites paths so the app works both locally and under the GitHub Pages subpath `/omeka-s-playground`
- crash recovery snapshots the DB and addon files before WASM crashes and restores them onto fresh runtimes

## Key features

- **Multiple PHP versions** — switch between PHP 8.1, 8.2, 8.3, 8.4, and 8.5 from the settings panel
- **Blueprints** — declarative JSON files that configure the playground state at boot
- **Crash recovery** — automatic WASM crash detection, DB snapshot, and replay of safe requests
- **PHP Info diagnostics** — capture phpinfo() output from the runtime for debugging
- **ZIP bundle loading** — Omeka core is distributed as a standard ZIP, cached with the Cache API

## Relationship to WordPress Playground

WordPress Playground is the main architectural reference for this repository. The project uses:

- `@php-wasm/web` and `@php-wasm/universal` for the PHP WASM runtime
- the same deferred initialization pattern (`loadWebRuntime()` → `new PHP()` → wrapper)
- a compatibility layer (`php-compat.js`) that adapts the @php-wasm API for Omeka's bootstrap

What changes here is the payload: this repository boots **Omeka S**, not WordPress, and the browser blueprint format is implemented in `src/shared/blueprint.js` and validated by `assets/blueprints/blueprint-schema.json`.

## Published documentation

These docs are built with MkDocs Material and published alongside the app on GitHub Pages:

- Playground: <https://ateeducacion.github.io/omeka-s-playground/>
- Docs: <https://ateeducacion.github.io/omeka-s-playground/docs/>
