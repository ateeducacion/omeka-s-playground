# Omeka S Playground

Omeka S Playground runs a full Omeka S instance in the browser with WebAssembly. It is inspired by the execution model of [WordPress Playground](https://wordpress.github.io/wordpress-playground/), but the application, runtime boot process, and `blueprint.json` schema in this repository are all Omeka-specific.

Use this documentation when you need to:

- understand how the browser runtime is assembled
- work safely with the default `blueprint.json`
- extend the project without breaking the readonly-core and persistent-overlay model
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
3. **Request routing** in `sw.js` and `php-worker.js`
4. **Omeka runtime boot** in `src/runtime/*`
5. **Local development proxy** in `scripts/dev-server.mjs`

At runtime:

- the readonly Omeka core is mounted from the prebuilt bundle in `assets/omeka/`
- mutable state lives under `/persist` in browser storage
- the shell hosts the running site in an iframe and exposes Home, Admin, and Docs navigation
- the service worker rewrites paths so the app works both locally and under the GitHub Pages subpath `/omeka-s-playground`

## Relationship to WordPress Playground

WordPress Playground is the main architectural reference for this repository. The project borrows the idea of:

- running PHP in the browser with WebAssembly
- bootstrapping an application on first load
- treating configuration as portable blueprint data
- persisting writable state separately from a readonly application image

What changes here is the payload: this repository boots **Omeka S**, not WordPress, and the browser blueprint format is implemented in `src/shared/blueprint.js` and validated by `assets/blueprints/blueprint-schema.json`.

## Why `blueprint.json` matters

The default blueprint at `assets/blueprints/default.blueprint.json` is the easiest way to understand the project. It controls:

- install metadata and defaults
- the landing page and login credentials
- users, item sets, items, media, modules, themes, and the default site

The blueprint is loaded into the shell, normalized, and then consumed by the runtime bootstrap. That makes it the main entry point for most contributor changes that affect demo content or first-boot behavior.

## Published documentation

These docs are built with MkDocs Material and published alongside the app on GitHub Pages:

- Playground: <https://ateeducacion.github.io/omeka-s-playground/>
- Docs: <https://ateeducacion.github.io/omeka-s-playground/docs/>
