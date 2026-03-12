# Getting started

## Prerequisites

You need the same core tools used by the main project:

- Node.js 18+
- npm
- Composer
- Git

For local docs preview, also use Python 3.

## Run the playground locally

```bash
git clone https://github.com/ateeducacion/omeka-s-playground.git
cd omeka-s-playground
make up
```

Then open <http://localhost:8080/>.

Default admin credentials come from `playground.config.json`:

- email: `admin@example.com`
- password: `password`

## Important files

| Area | File or directory | Why it matters |
| --- | --- | --- |
| Shell UI | `index.html`, `src/shell/main.js`, `src/styles/app.css` | Top navigation, iframe host, toolbar actions, side panel |
| Runtime host | `remote.html`, `src/remote/main.js` | Registers the service worker and hosts the scoped runtime |
| Routing | `sw.js`, `php-worker.js` | Maps browser requests into the WASM PHP runtime |
| Boot logic | `src/runtime/bootstrap.js` | Installs Omeka, applies blueprint state, handles autologin |
| Blueprint schema | `assets/blueprints/blueprint-schema.json` | Documents the accepted `blueprint.json` shape |
| Default blueprint | `assets/blueprints/default.blueprint.json` | Baseline demo content and first-boot configuration |
| Docs config | `mkdocs.yml`, `docs/` | Source and navigation for this documentation site |

## Where `blueprint.json` lives

The repository ships its default blueprint at:

`assets/blueprints/default.blueprint.json`

Users can also supply a blueprint through:

- `?blueprint=/path/to/file.json`
- `?blueprint-data=...` with base64url-encoded JSON
- the **Import** button in the side panel

The shell resolves that input in `src/shared/blueprint.js`, saves the active blueprint for the current scope, and triggers a clean runtime boot when the blueprint changes.

## Preview the docs locally

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-docs.txt
mkdocs serve
```

Open <http://127.0.0.1:8000/> to preview the docs.

Before committing documentation changes, run:

```bash
mkdocs build --strict
```

## What to validate after changes

For shell or runtime changes, the repository relies on targeted checks instead of a large formal test suite.

Useful commands include:

```bash
node --check src/shell/main.js
node --check src/runtime/bootstrap.js
node --check src/runtime/vfs.js
node --check sw.js
node --check php-worker.js
```

Manual checks are especially important for:

- first boot installation
- reloads with persisted state
- autologin into `/admin`
- navigation within the Omeka admin
- GitHub Pages subpath behavior
