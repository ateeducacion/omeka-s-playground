# Development

## Contributing to the playground

The smallest safe workflow for most contributor changes is:

1. identify the layer you need to touch
2. make a targeted change
3. run the narrowest relevant validation commands
4. manually verify first boot, reload behavior, or UI changes when applicable
5. update docs if the behavior or contributor workflow changed

## Development commands

```bash
make deps
make prepare
make bundle
make serve
```

Common targeted syntax checks:

```bash
node --check src/shell/main.js
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
```

## Documentation maintenance

Documentation source lives in `docs/`, and the site configuration lives in `mkdocs.yml`.

### Preview docs locally

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-docs.txt
mkdocs serve
```

### Build docs locally

```bash
mkdocs build --strict
```

Use strict mode before opening a pull request so broken internal links or configuration issues are caught early.

## GitHub Pages publishing

The Pages workflow in `.github/workflows/pages.yml` now publishes two things together:

- the main static playground app at the repository root
- the generated documentation site under `/docs/`

The workflow:

1. checks out the repository
2. installs Node, PHP, and Python dependencies
3. prepares runtime assets and builds the Omeka bundle
4. builds the MkDocs site into the deploy artifact's `docs/` directory
5. uploads the assembled artifact to GitHub Pages

This keeps the public URLs stable:

- app: <https://ateeducacion.github.io/omeka-s-playground/>
- docs: <https://ateeducacion.github.io/omeka-s-playground/docs/>

## Documentation expectations for contributors

When you touch these areas, update the docs in the same pull request:

- runtime lifecycle or storage model
- `blueprint.json` semantics
- local development or deployment workflows
- navigation or externally visible user workflows

Good docs changes in this repository should:

- describe the actual implementation, not generic Playground theory
- include concrete file paths
- explain both the feature and the safest way to maintain it

## PHP CLI spawn handler

The playground registers a **spawn handler** on the `@php-wasm` runtime so
that PHP's `proc_open()` / `exec()` calls are intercepted in JavaScript and
handled in-process rather than silently failing.

### What works

- **PHP CLI commands** — commands whose binary is `php` or an absolute path
  ending in `/php` are executed in the same WASM runtime via `php.run()`.
  This enables Omeka's `Omeka\Stdlib\Cli::execute()` to run PHP scripts
  such as the job dispatcher (`application/omeka jobs:dispatch`).
- **Inline code** via `php -r "..."` is also supported.
- **stdout / stderr / exit code** are captured and propagated back to the
  calling PHP code.

### What is still limited

| Area | Status | Reason |
|---|---|---|
| Background jobs | Synchronous | The dispatch strategy remains `Synchronous`. The spawn handler runs PHP scripts in the same single-threaded WASM instance, so true async dispatch is not possible. |
| ImageMagick (`convert`) | Blocked | No WASM ImageMagick binary is available. Thumbnails use GD or fall back to no-thumbnail mode. |
| Arbitrary binaries | Blocked | Only PHP binaries from the allowlist are permitted. Unknown commands receive exit code 127. |
| Recursive spawns | Depth-limited | A re-entrant guard (`MAX_SPAWN_DEPTH = 3`) prevents infinite recursion when a spawned PHP script itself calls `exec()`. |
| True parallelism | Not supported | All spawned commands execute synchronously in the same WASM instance. There is no subprocess isolation. |

### Security model

The spawn handler uses a **binary allowlist** (`PHP_BIN_ALLOWLIST` in
`src/runtime/spawn-handler.js`). Commands not on the list are rejected
with a descriptive stderr message and exit code 127. The ImageMagick
guard in the `Omeka\Cli` override (`src/runtime/bootstrap.js`) is
checked first, before the command reaches `exec()`.

### Key files

- `src/runtime/spawn-handler.js` — handler registration, allowlist, in-process execution
- `src/runtime/php-loader.js` — calls `registerSpawnHandler()` after PHP init
- `src/runtime/bootstrap.js` — `Omeka\Cli` override delegates PHP commands to `exec()`
- `tests/spawn-handler.test.mjs` — unit tests for allowlist and spawn logic
