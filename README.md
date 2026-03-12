# Omeka S Playground

> [Omeka S](https://omeka.org/s/) in the browser, powered by WebAssembly. No server required.

This project runs a full [Omeka S](https://omeka.org/s/) instance entirely in the browser using [php-wasm](https://github.com/nicordev/nicordev-php-wasm). The readonly Omeka core is loaded from a pre-built bundle while a writable overlay persisted in the browser handles the database, uploads, and configuration.

[Live demo](https://ateeducacion.github.io/omeka-s-playground/) | [Documentation](https://ateeducacion.github.io/omeka-s-playground/docs/) | [Report a bug](https://github.com/ateeducacion/omeka-s-playground/issues)

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
- [Node.js 18+](https://nodejs.org/) (also used by the local dev server)
- [Git](https://git-scm.com/)

### Make targets

| Command | Description |
|---------|-------------|
| `make up` | Install deps, build the Omeka bundle, and serve locally |
| `make prepare` | Install npm deps and vendor browser runtime assets |
| `make bundle` | Fetch Omeka, run Composer, build the VFS image and manifest |
| `make serve` | Start the local dev server on port 8080, including the addon download proxy |
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
- Passing `?blueprint-data=...` in the URL with a base64url-encoded UTF-8 JSON blueprint payload.
- Importing a `.json` file from the toolbar.

### What blueprints can configure

- Landing page, installation title, locale, and timezone
- Debug mode for Omeka/PHP error visibility
- Admin and additional users
- A default site with a theme selection
- Item sets and items with remote media
- Module installation/activation from bundled addons, direct ZIP URLs, or `omeka.org` slugs
- Theme installation from bundled addons, direct ZIP URLs, or `omeka.org` slugs

### Example

```json
{
  "$schema": "./assets/blueprints/blueprint-schema.json",
  "debug": {
    "enabled": true
  },
  "landingPage": "/s/demo",
  "siteOptions": {
    "title": "Demo Omeka",
    "locale": "es",
    "timezone": "Atlantic/Canary"
  },
  "users": [
    { "username": "admin", "email": "admin@example.com", "password": "password", "role": "global_admin" }
  ],
  "themes": [
    {
      "name": "Foundation",
      "source": { "type": "omeka.org", "slug": "foundation-s" }
    }
  ],
  "modules": [
    { "name": "CSVImport", "state": "activate" },
    {
      "name": "NumericDataTypes",
      "state": "install",
      "source": { "type": "omeka.org", "slug": "numeric-data-types" }
    },
    {
      "name": "Mapping",
      "state": "activate",
      "source": { "type": "url", "url": "https://example.com/Mapping.zip" }
    }
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
    "theme": "Foundation",
    "setAsDefault": true
  }
}
```

The full schema is at [`assets/blueprints/blueprint-schema.json`](assets/blueprints/blueprint-schema.json).

When `debug.enabled` is `true`, the playground switches that scope into a development-like Omeka/PHP mode so browser `500` responses expose more useful detail. Use it for diagnosis, not for normal demo blueprints.

For embedded URL payloads, `blueprint-data` expects the JSON blueprint encoded as base64url. Standard base64 is also accepted as long as it is URL-encoded safely.

Example:

```text
?blueprint-data=eyJsYW5kaW5nUGFnZSI6Ii9hZG1pbiIsInNpdGVPcHRpb25zIjp7InRpdGxlIjoiRW1iZWRkZWQgRGVtbyJ9fQ
```

Short form strings remain supported for bundled addons:

```json
{
  "modules": ["CSVImport"],
  "themes": ["default"]
}
```

Remote addons are downloaded into persistent browser storage under `/persist/addons` and re-linked into Omeka on each boot. This means the readonly core bundle stays untouched while downloaded modules/themes survive reloads for the same playground scope.

When running locally, the dev server exposes a same-origin addon proxy at the configured `addonProxyPath` so browser-based runtime fetches can read cross-origin ZIPs from GitHub Releases and similar hosts.

In the public GitHub Pages deployment, the app uses the external ZIP proxy configured via `addonProxyUrl` instead. This is required because GitHub Pages is static-only and cannot implement `__addon_proxy__`, and direct browser fetches to GitHub/Codeload ZIP downloads are not reliable due to CORS. The current production worker is `https://zip-proxy.erseco.workers.dev/`, and its source is kept in [`scripts/zip-proxy-worker.js`](scripts/zip-proxy-worker.js).

The PHP runtime also supports outbound `http`/`https` stream access through VRZNO. In this app those requests are filtered by the `outboundHttp` config, which applies an allowlist and can route cross-origin traffic through the active proxy configuration.

---

## Deployment

The project deploys as a **static site** — no backend needed.

A [GitHub Pages workflow](.github/workflows/pages.yml) is included and runs automatically on push to `main`. It installs dependencies, builds the Omeka bundle, renders the MkDocs site under `/docs/`, and publishes the app plus docs together.

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

- Remote addon installation only supports ZIP packages that are already ready to run in Omeka. Releases that require Composer, Node builds, or extra post-install steps are not supported in-browser.
- `omeka.org` slug resolution depends on the current HTML download links on omeka.org.
- Remote ZIP downloads need a proxy endpoint when the upstream host does not expose CORS headers. The local dev server provides a same-origin proxy for development, and the public GitHub Pages deployment uses the configured external ZIP proxy worker.
- PHP outbound HTTP is limited by the configured `outboundHttp.allowedHosts` and `allowedMethods`. Hosts outside that policy will fail by design.
- Browser compatibility is focused on Chromium; Firefox and Safari may need additional validation for IndexedDB and Service Worker behavior.
- The export/import of full overlay snapshots is still being hardened.

---

## Prior Art

- [WordPress Playground](https://github.com/WordPress/wordpress-playground) — the original inspiration for running a PHP CMS entirely in the browser.

---

## Contributing

Contributions are welcome. [Open an issue](https://github.com/ateeducacion/omeka-s-playground/issues) or submit a pull request.

## License

See the repository for license details.
