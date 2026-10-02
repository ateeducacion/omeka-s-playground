# `blueprint.json`

## What it is

In this repository, `blueprint.json` is the portable description of the initial Omeka S state that should exist inside a playground scope.

The default file is:

`assets/blueprints/default.blueprint.json`

It follows the shared [Omeka S blueprint format](https://github.com/omeka-s-contrib/omeka-s-blueprints), also used by [Omeka-S-Cli](https://github.com/GhentCDH/Omeka-S-Cli). Settings that only make sense in the browser live under `x-playground`. It is inspired by WordPress Playground blueprints, but it is **not** the upstream WordPress schema.

- schema: [`v0`](https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json), the latest `v0.x.y` release of the shared format
- normalization logic: `src/shared/blueprint.js`

Blueprints written for the earlier Playground format keep working; see [Legacy format](#legacy-format).

## How the repository uses it

The shell loads a blueprint, normalizes missing values, and stores the active version for the current scope. The runtime then consumes that normalized blueprint during boot to:

- set install metadata such as title, locale, and timezone
- create and authenticate the primary admin account
- create additional users and apply per-user settings
- download, install, or activate modules and themes
- apply global settings
- create item sets, items, and media
- create one or more sites, assign per-site user permissions, and pick the default
- choose the landing page after boot

Because the blueprint influences first-boot behavior, a small JSON change can alter installation, login, routing, or demo content.

## Structure used by this project

The most important top-level properties are:

| Property | Purpose | Notes |
| --- | --- | --- |
| `$schema` | Editor/schema reference | `https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json` |
| `meta` | Human-readable metadata | Good place for title, author, and description |
| `preferredVersions` | Informational runtime targets | Useful for intent, not a strict installer lockfile |
| `install` | Install values | `title`, `locale`, `timezone`, and the first administrator in `admin` (`name`, `email`, `password`) |
| `settings` | Global Omeka settings | Setting id → value, or a list of such maps merged in order; see [Global settings](#global-settings) |
| `users` | Omeka users to create | Each may carry `settings`; `install.admin` goes first |
| `themes` | Themes to install | See [Add-on sources](#add-on-sources) |
| `modules` | Modules to download, install, or activate | See [Add-on sources](#add-on-sources); a repeated name overrides the earlier entry |
| `files` | Files placed in the Omeka S installation | See [Files](#files) |
| `itemSets` | Collections created before items | Referenced by item titles later |
| `items` | Sample resources and media | Media currently uses URL sources; `items[].sites` assigns sites by slug |
| `sites` | One or more public sites with per-site permissions | One is the default |
| `x-playground` | Browser runtime settings | `landingPage`, `login`, `debug`, `phpConstants`; see [Playground settings](#playground-settings-x-playground) |

## Playground settings (`x-playground`)

Other consumers of the format ignore this block.

| Property | Purpose | Notes |
| --- | --- | --- |
| `landingPage` | Initial post-boot path | Should usually begin with `/` |
| `login` | Credentials used by autologin | Defaults to `install.admin`, else the first user |
| `debug.enabled` | Enables development-style diagnostics | Helpful for install/debug sessions |
| `phpConstants` | PHP constants defined before Omeka boots | Name → boolean / string / number; see [PHP constants](#php-constants) |

## Add-on sources

`modules[].source` and `themes[].source` are a single string:

- a ZIP URL, used as is (it already pins a release, so it wins over `version`);
- a GitHub repository, as `gh:owner/repo` or `https://github.com/owner/repo(.git)`: the archive of the `#ref` in the source, else of `version` (a tag or branch), else of the default branch;
- nothing: the add-on shipped with the core is used (e.g. the `default` theme); otherwise the name is looked up in the omeka.org catalog (`s_module.json` / `s_theme.json`), at `version` or the latest release.

Other git hosts, `git@` URLs and other schemes are rejected. A release resolved from the catalog is cached, so later boots do not fetch the catalog again; change `version` to move to another release.

## Files

`files` places files in the Omeka S installation after modules and themes, for example a module config file or an extra asset bundle for a module:

```json
{
  "files": [
    { "source": "./config/cleanurl.config.php", "destination": "config/cleanurl.config.php" },
    { "source": "https://example.org/editor.zip", "destination": "modules/ExeLearning/dist/static", "extract": true }
  ]
}
```

- `destination` is relative to the Omeka S root; absolute paths and `..` segments are rejected.
- With `extract: true`, `source` is a ZIP extracted into `destination`; a single top-level folder in the archive is stripped, as with add-on ZIPs.
- Files are cached by source and re-applied on every boot, because the Omeka S root is rebuilt from the core bundle.

## PHP constants

`x-playground.phpConstants` defines PHP constants in the runtime's `auto_prepend` file, which runs
**before Omeka boots**, so they are visible to module `defined()` / `getenv()` checks. Each
entry is emitted as a guarded `define()`:

```json
{
  "x-playground": {
    "phpConstants": {
      "MY_FLAG": true,
      "MY_LABEL": "demo",
      "MY_LIMIT": 50
    }
  }
}
```

becomes:

```php
if (!defined('MY_FLAG')) { define('MY_FLAG', true); }
if (!defined('MY_LABEL')) { define('MY_LABEL', 'demo'); }
if (!defined('MY_LIMIT')) { define('MY_LIMIT', 50); }
```

Values may be boolean, string or number; constant names must match `^[A-Z_][A-Z0-9_]*$`
(other names are skipped). This lets a module's own blueprint enable module-specific
configuration without the playground engine knowing anything module-specific. For example,
the eXeLearning module declares the `EXELEARNING_UNSAFE_LEGACY_IFRAME` constant
so its demo renders the content iframe same-origin (the php-wasm service worker cannot serve
an opaque subframe); a real Omeka install never defines that constant.

## Global settings

`settings` writes Omeka global settings (the `setting` table) by id. It accepts a map, or a
list of maps merged in order, where a later map overrides earlier values:

```json
{
  "settings": [
    { "installation_title": "Classroom Demo", "pagination_per_page": 50 },
    { "locale": "es" }
  ]
}
```

- Values are stored as-is (strings, numbers, booleans, arrays, or objects).
- Settings are applied after every module is installed, so they override module defaults,
  and after `install`, so for example `installation_title` wins over `install.title`.
- Like `install`, they are re-applied on every boot of the same scope.
- When the blueprint defines sites, `default_site` is set afterwards from them; use `setAsDefault` instead.
- `$import` references from the [shared blueprint specification](https://github.com/omeka-s-contrib/omeka-s-blueprints)
  are not supported yet and are rejected.

## Example

```json
{
  "$schema": "https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json",
  "meta": {
    "title": "Demo classroom blueprint",
    "author": "ateeducacion",
    "description": "Creates a reusable demo site with sample media."
  },
  "install": {
    "title": "Classroom Demo",
    "locale": "es",
    "timezone": "Atlantic/Canary",
    "admin": { "name": "admin", "email": "admin@example.com", "password": "password" }
  },
  "themes": ["foundation"],
  "modules": [
    { "name": "CSVImport", "state": "activate" }
  ],
  "itemSets": [
    { "title": "Playground Collection" }
  ],
  "items": [
    {
      "title": "Openverse Sample Image",
      "itemSets": ["Playground Collection"],
      "media": [
        {
          "type": "url",
          "url": "./assets/samples/playground-sample.png",
          "title": "Playground sample image"
        }
      ]
    }
  ],
  "sites": [
    { "title": "Demo Site", "slug": "demo-site", "theme": "foundation", "setAsDefault": true }
  ],
  "x-playground": {
    "landingPage": "/admin",
    "debug": { "enabled": false }
  }
}
```

## Multiple sites, permissions, and per-user settings

Use the `sites` array to provision more than one site and to grant users access
to specific sites. This is what makes access-control modules such as
[IsolatedSites](https://github.com/ateeducacion/omeka-s-IsolatedSites) testable
in the browser: give a user a per-site role, flip a per-user setting, and assign
items to individual sites.

- `sites[]` accepts `title`, `slug`, `summary`, `theme`, `isPublic`,
  `setAsDefault` and `permissions`.
- `sites[].permissions[]` grants an existing blueprint **user** (by email) a
  site role of `viewer`, `editor`, or `admin`.
- Exactly one site is the default. If no entry sets `setAsDefault: true`, the
  first one is used.
- `users[].settings` is an object written verbatim to each user's settings
  (`user_setting`), e.g. `limit_to_granted_sites`.
- `items[].sites` lists the site slugs (titles are also accepted and slugified)
  an item is assigned to. Without it, items go to the default site.

```json
{
  "users": [
    { "username": "admin", "email": "admin@example.com", "password": "password", "role": "global_admin" },
    {
      "username": "editor_a",
      "email": "editor.a@example.com",
      "password": "password",
      "role": "site_editor",
      "settings": { "limit_to_granted_sites": true, "limit_to_own_assets": true }
    }
  ],
  "sites": [
    {
      "title": "Site A",
      "slug": "site-a",
      "setAsDefault": true,
      "permissions": [{ "user": "editor.a@example.com", "role": "admin" }]
    },
    { "title": "Site B", "slug": "site-b" }
  ],
  "items": [
    { "title": "Doc A1", "sites": ["site-a"] },
    { "title": "Doc B1", "sites": ["site-b"] }
  ]
}
```

With this blueprint, signing in as `editor.a@example.com` (with IsolatedSites
active) shows only Site A and its items, while the admin keeps full visibility.

## Example file for Common + EasyAdmin

There is a ready-to-copy example at:

`blueprint-sample.json`

That sample installs `Common` first and then `EasyAdmin`. It is the better file to reuse here because it is already tracked as a real project sample, so the documentation should point at it instead of duplicating a second near-identical blueprint under `docs/`.

## How to write and maintain it well

### Keep it readable

- Prefer one clear responsibility per section.
- Keep related values grouped together instead of scattering overrides.
- Use descriptive `meta.title` and `meta.description` values so future contributors understand intent immediately.

### Keep it stable

- Prefer bundled add-ons or omeka.org releases (no `source`, with a `version`) before remote ZIP URLs.
- Avoid accidental duplicate module or theme names. The last occurrence wins, and a warning is logged when it changes the earlier definition.
- Keep `x-playground.landingPage` simple and explicit. `/admin` is the safest default for contributor-oriented blueprints.

### Keep it maintainable

- Declare the administrator in `install.admin`; it becomes the first user and the autologin account.
- Only set `x-playground.login` to sign in as another user.
- Use a small number of representative sample items instead of large demo datasets that slow down resets and reviews.
- Prefer relative media URLs for repository-bundled samples when possible.

## Project-specific rules and conventions

These conventions come from the current implementation, not generic JSON style advice:

- `x-playground.landingPage` is normalized to start with `/`.
- Any role id is accepted, including roles added by modules (e.g. `guest`). As a Playground convenience, `admin` and `supervisor` are mapped to `global_admin` and `site_admin`.
- Addon names must be a single path segment; slashes and traversal-like names are rejected.
- Remote addon URLs are absolutized against the current page URL.
- `modules[].state` supports `download` (place files only), `install`, and `activate` (default).
- `modules[].version` and `themes[].version` select the omeka.org release, or the tag/branch of a GitHub source.
- Duplicate module or theme names (case-insensitive) follow the shared specification: the last occurrence wins and takes its position in the list.
- `items[].media[].type` currently supports `url`.
- Exactly one site is forced to be the default (the first one if none is flagged), and duplicate site slugs are rejected.
- `sites[].permissions[].role` is clamped to one of `viewer`, `editor`, `admin` (defaults to `viewer`); a permission whose `user` email matches no created user is skipped with a warning.
- `items[].sites` entries are slugified to match site slugs; items with no match fall back to the default site.
- `users[].settings` keys are written verbatim to `user_setting`; values are stored as-is.

If you change the semantics of any of those rules, update both the schema and the documentation together.

## How to validate changes

1. Edit the blueprint JSON.
2. Validate it against the [`v0` schema](https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json) (editors do it from `$schema`).
3. Start the app and trigger a clean boot by importing the blueprint or using a new scope.
4. Confirm the expected landing page, users, modules, themes, and sample content appear.
5. If something fails during boot, temporarily enable `x-playground.debug.enabled`.

Useful targeted checks:

```bash
node --check src/shared/blueprint.js
node --check src/runtime/bootstrap.js
```

## Common mistakes to avoid

- **Using the upstream WordPress Playground schema as if it were identical.** This repository implements its own Omeka-specific blueprint format.
- **Adding hidden assumptions to runtime code instead of the blueprint.** That makes the setup harder to reason about.
- **Setting `x-playground.login` to a user the blueprint does not create.** Autologin fails.
- **Using fragile remote ZIP URLs.** If the URL needs unusual redirects or post-install steps, it may not work in-browser.
- **Overloading the blueprint with too much sample content.** Large initial datasets slow resets and make review harder.

## Troubleshooting

### The playground boots but lands on the wrong page

Check `x-playground.landingPage`, current shell session state, and whether autologin bypassed a saved `/login` path.

### A module or theme does not install

Verify the addon `name`, the `source` definition, and whether the remote host is compatible with the configured proxy and outbound HTTP policy.

### Media fails to load

Confirm the URL resolves correctly from the deployed base path or local dev server. Relative sample paths are resolved against the current page URL.

### A blueprint import appears to do nothing

The shell only applies imported data after parsing and normalization. Check the browser console, shell logs, and whether the payload is valid JSON/base64url for `blueprint-data`.

## Legacy format

Blueprints written for the earlier Playground format still load. Each legacy key maps onto the shared format; when both forms are present, the shared one wins.

| Legacy | Shared format |
| --- | --- |
| `siteOptions` | `install` (`title`, `locale`, `timezone`) |
| `login` | `install.admin`, or `x-playground.login` for another account |
| `landingPage`, `debug`, `phpConstants` | `x-playground.landingPage`, `x-playground.debug`, `x-playground.phpConstants` |
| `site` | `sites` with one entry (ignored when `sites` is present) |
| `source: { "type": "url", "url": "…" }` | `source: "…"` |
| `source: { "type": "omeka.org", "slug": "…" }`, `{ "type": "bundled" }` | no `source` (resolved by `name`) |
| `modules[].assets: [{ "url", "destination" }]` | `files: [{ "source", "destination": "modules/<name>/<destination>", "extract": true }]` |

The editor's **Export** always writes the shared format. The previous schema stays at `assets/blueprints/blueprint-schema.json` for blueprints that still point to it.
