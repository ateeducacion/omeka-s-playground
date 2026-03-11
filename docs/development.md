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
