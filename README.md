# Omeka S Playground

> [Omeka S](https://omeka.org/s/) in the browser, powered by WebAssembly. No server required.

Inspired by [WordPress Playground](https://github.com/WordPress/wordpress-playground), this project runs a full [Omeka S](https://omeka.org/s/) instance entirely in the browser using [php-wasm](https://github.com/nicordev/nicordev-php-wasm). The readonly Omeka core is loaded from a pre-built bundle while a writable overlay persisted in the browser handles the database, uploads, and configuration.

[Live demo](https://ateeducacion.github.io/omeka-s-playground/) | [Report a bug](https://github.com/ateeducacion/omeka-s-playground/issues)

![](https://raw.githubusercontent.com/ateeducacion/omeka-s-playground/main/.github/screenshot.png)

---

## Getting Started

### Quick start

```bash
git clone https://github.com/ateeducacion/omeka-s-playground.git
cd omeka-s-playground
make up
```

Open <http://localhost:8080> and you will land on a fully installed Omeka S admin panel.

Default credentials: `admin@example.com` / `password` (configurable in [`playground.config.json`](playground.config.json)).

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18 + npm
- [Composer](https://getcomposer.org/)
- [Python 3](https://www.python.org/) (for the local static server)
- [Git](https://git-scm.com/)

### Make targets

| Command | Description |
|---------|-------------|
| `make up` | Install deps, build the Omeka bundle, and serve locally |
| `make prepare` | Install npm deps and vendor browser runtime assets |
| `make bundle` | Fetch Omeka, run Composer, build the VFS image and manifest |
| `make serve` | Start a static server on port 8080 |
| `make clean` | Remove generated bundle and vendored runtime assets |

---

## How It Works

```
index.html          Shell UI (toolbar, address bar, log panel, iframe viewport)
  └─ remote.html    Runtime host — registers the Service Worker
       ├─ sw.js     Intercepts requests and forwards them to the PHP worker
       └─ php-worker.js
            └─ php-cgi-wasm (WebAssembly)
                 ├─ Readonly Omeka core  (assets/omeka/*.vfs.*)
                 └─ Writable overlay     (IndexedDB — SQLite, config, files/)
```

On first boot the PHP worker automatically:

1. Mounts the readonly Omeka core bundle.
2. Writes SQLite configuration.
3. Runs the Omeka installer programmatically.
4. Creates the admin user.

Subsequent reloads skip the install unless the bundle version changes.

---

## Blueprints

Blueprints are JSON files that describe the desired state of a playground instance — similar to [WordPress Playground Blueprints](https://wordpress.github.io/wordpress-playground/blueprints/).

A default blueprint is bundled at [`assets/blueprints/default.blueprint.json`](assets/blueprints/default.blueprint.json). You can override it by:

- Passing `?blueprint=/path/to/file.json` in the URL.
- Importing a `.json` file from the toolbar.

### What blueprints can configure

- Landing page, installation title, locale, and timezone
- Admin and additional users
- A default site with a theme selection
- Item sets and items with remote media
- Module activation (from modules already in the bundle)

### Example

```json
{
  "$schema": "./assets/blueprints/blueprint-schema.json",
  "landingPage": "/s/demo",
  "siteOptions": {
    "title": "Demo Omeka",
    "locale": "es",
    "timezone": "Atlantic/Canary"
  },
  "users": [
    { "username": "admin", "email": "admin@example.com", "password": "password", "role": "global_admin" }
  ],
  "modules": [
    { "name": "CSVImport", "state": "activate" }
  ],
  "itemSets": [
    { "title": "Demo Collection" }
  ],
  "items": [
    {
      "title": "Landscape sample",
      "itemSets": ["Demo Collection"],
      "media": [{ "type": "url", "url": "https://example.com/photo.jpg", "title": "Photo" }]
    }
  ],
  "site": {
    "title": "Demo Site",
    "slug": "demo",
    "theme": "default",
    "setAsDefault": true
  }
}
```

The full schema is at [`assets/blueprints/blueprint-schema.json`](assets/blueprints/blueprint-schema.json).

---

## Deployment

The project deploys as a **static site** — no backend needed.

A [GitHub Pages workflow](.github/workflows/pages.yml) is included and runs automatically on push to `main`. It installs dependencies, builds the Omeka bundle, and publishes the result.

---

## Key Technologies

| Technology | Role |
|-----------|------|
| [php-cgi-wasm](https://www.npmjs.com/package/php-cgi-wasm) | PHP 8.3 compiled to WebAssembly |
| [Omeka S](https://omeka.org/s/) (SQLite branch) | The digital collections platform being served |
| [Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) | Intercept HTTP requests and route them to the WASM runtime |
| [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) | Browser-persistent storage for the writable overlay |

The Omeka source is built from the [`feature/experimental-sqlite-support`](https://github.com/ateeducacion/omeka-s/tree/feature/experimental-sqlite-support) branch of [ateeducacion/omeka-s](https://github.com/ateeducacion/omeka-s).

---

## Known Limitations

- Remote installation of third-party modules/themes from omeka.org is not yet supported — only modules already present in the bundle can be activated.
- Browser compatibility is focused on Chromium; Firefox and Safari may need additional validation for IndexedDB and Service Worker behavior.
- The export/import of full overlay snapshots is still being hardened.

---

## Prior Art

- [WordPress Playground](https://github.com/WordPress/wordpress-playground) — the original inspiration for running a PHP CMS entirely in the browser.
- [Moodle Playground](https://github.com/nicordev/nicordev-moodle-playground) — reference for the VFS bundle and build pipeline.

---

## Contributing

Contributions are welcome. [Open an issue](https://github.com/ateeducacion/omeka-s-playground/issues) or submit a pull request.

## License

See the repository for license details.
