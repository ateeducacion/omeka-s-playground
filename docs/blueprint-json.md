# `blueprint.json`

## What it is

In this repository, `blueprint.json` is the portable description of the initial Omeka S state that should exist inside a playground scope.

The default file is:

`assets/blueprints/default.blueprint.json`

It follows the shared [Omeka S blueprint format](https://github.com/omeka-s-contrib/omeka-s-blueprints), also used by [Omeka-S-Cli](https://github.com/GhentCDH/Omeka-S-Cli). Settings that only make sense in the browser live under `x-playground`. It is inspired by WordPress Playground blueprints, but it is **not** the upstream WordPress schema.

- schema: [`v0`](https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json), the latest `v0.x.y` release of the shared format (local copy: `assets/blueprints/shared/v0/blueprint-schema.json`)
- loading, `$import` and normalization: `src/shared/blueprint-imports.js`, `src/shared/blueprint.js`
- what the Playground does with each key: [Support matrix](#support-matrix)

The same `blueprint.json` can be used by the Playground and by [Omeka-S-Cli](https://github.com/GhentCDH/Omeka-S-Cli) (`blueprint:deploy`, which the [`erseco/alpine-omeka-s`](https://github.com/erseco/alpine-omeka-s) Docker image runs from `OMEKA_BLUEPRINT`). Options for one of them go under its own `x-` key (`x-playground` here); the other ignores it.

Blueprints written for the earlier Playground format keep working; see [Legacy format](#legacy-format).

## How the repository uses it

The shell loads a blueprint, normalizes missing values, and stores the active version for the current scope. The runtime then consumes that normalized blueprint during boot to:

- set install metadata such as title, locale, and timezone
- create and authenticate the primary admin account
- create additional users and apply per-user settings
- download, install, or activate modules and themes
- import RDF vocabularies and resource templates
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
| `users` | Omeka users to create | Each may carry `settings`; `install.admin` goes first; a user without `password` gets the configured admin password |
| `themes` | Themes to install | See [Add-on sources](#add-on-sources) |
| `modules` | Modules to download, install, or activate | See [Add-on sources](#add-on-sources); a repeated name overrides the earlier entry |
| `files` | Files placed in the Omeka S installation | See [Files](#files) |
| `vocabularies` | RDF vocabularies to import | See [Vocabularies](#vocabularies) |
| `resourceTemplates` | Resource-template exports to import | See [Resource templates](#resource-templates) |
| `itemSets` | Collections created before items | Referenced by item titles later |
| `items` | Sample resources and media | Media currently uses URL sources; `items[].sites` assigns sites by slug |
| `sites` | One or more public sites with per-site permissions | One is the default |
| `x-playground` | Browser runtime settings | `landingPage`, `login`, `debug`, `phpConstants`; see [Playground settings](#playground-settings-x-playground) |

Every list except `sites` can also hold [`$import`](#imports-import) entries.

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
- a local ZIP release: a path relative to the file that declares the entry (see [Relative paths](#relative-paths)), as in Omeka-S-Cli;
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
- A relative `source` resolves against the file that declares it (see [Relative paths](#relative-paths)).

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
- In the list form, entries can be [`$import`](#imports-import) references. An imported document
  is a map, or a list of maps and further references; everything is merged in order.

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
- `slug` may only contain letters, digits, `_` and `-`, and is kept as written.
  Without one, Omeka S derives it from the title, and the title identifies the
  site on later boots.
- A site that already exists (same slug, else same title) is left as it is, so
  changes made in the admin survive a reload. New sites add newly created items
  automatically, as in the Omeka admin, and the administrator who creates them
  is their owner and a site admin.
- `sites[].permissions[]` grants a blueprint **user** (by email) a site role of
  `viewer` (the default), `editor`, or `admin`. A missing permission is added on
  every boot; a user who already has another role keeps it (with a warning); no
  permission is removed.
- Exactly one site is the default. If no entry sets `setAsDefault: true`, the
  first one is used. The `default_site` setting is written when the site is created.
- `users[].settings` is an object written verbatim to each user's settings
  (`user_setting`), e.g. `limit_to_granted_sites`.
- `items[].sites` lists the slugs or titles (case-insensitive) of the sites an
  item is assigned to. Without it, items go to the default site.

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

## Comments (JSONC)

Blueprints and imported files may contain comments (`//` and `/* */`) and trailing commas, as Omeka-S-Cli reads them (`.jsonc`). This applies to every way a blueprint arrives: `?blueprint-url=`, `?blueprint=`, uploads, the editor and `$import`. JSON tooling and the shared schema only see the parsed document. The editor's **Export** writes plain JSON.

```jsonc
{
  "modules": [
    "Common", // needed by the module below
    { "$import": "./partials/modules.jsonc" },
  ],
}
```

## Imports (`$import`)

Any entry of `modules`, `themes`, `files`, `vocabularies`, `resourceTemplates`, `users`,
`sites`, `itemSets`, `items` and the list form of `settings` can be a reference to another JSON file:

```json
{
  "modules": ["Common", { "$import": "./partials/modules.json" }],
  "vocabularies": [{ "$import": "https://example.org/shared/vocabularies.json" }]
}
```

- The referenced file holds more entries of the same list, or a single entry, and they are spliced in place of the reference.
- An imported file can import further files. A cycle stops the boot with the chain of files
  (`Circular $import: a.json -> b.json -> a.json`); importing the same file twice from different places is fine. Nesting is limited to 16 levels.
- The reference is an `http(s)` URL, a path relative to the file that contains it, or a GitHub/GitLab file reference as Omeka-S-Cli accepts them:
  `gh:owner/repo[@ref]:path`, `gl:group/repo[@ref]:path`, or a `github.com/…/blob/…` or `…/-/blob/…` page URL (turned into the raw file URL).
- Absolute paths (`/…`, `\\…`, `C:\…`) and `file:` URLs are rejected, as in Omeka-S-Cli, and so are other schemes (`data:`, …).
- Imported files are fetched by the browser, like `?blueprint-url=` itself, so their host must allow CORS (GitHub raw files do).
- A failed download, a file that is not JSON, or a file that is not a list or an object stops the boot with the file's URL. When the blueprint declares the shared `$schema`, every imported file is also validated against the schema of its list.
- `sites` takes `$import` as in Omeka-S-Cli 0.18, although the shared `v0` schema does not list it yet: imported sites are checked against the schema's site definition. An `$import` anywhere else (such as a settings map) is rejected instead of being ignored.

### Relative paths

Relative paths resolve against the file that contains them (RFC 3986), not against the root blueprint:

| Where | Relative to |
| --- | --- |
| `$import` in the blueprint | the blueprint URL |
| `$import` in an imported file | that imported file |
| `files[].source`, `vocabularies[].source`, `resourceTemplates[].source` | the file that declares the entry |
| `modules[].source`, `themes[].source` given as a path (a local ZIP) | the file that declares the entry |

How the blueprint arrives decides whether it has a URL:

| Blueprint | Base URL |
| --- | --- |
| `?blueprint-url=…`, `?blueprint=https://…`, the configured default blueprint | that URL |
| `?blueprint=<base64>` (also what the editor's **Run** uses), `?blueprint-data=`, an uploaded file | none |

Without a base URL, a relative `$import` stops the boot with an error (the editor and the upload already refuse it), because there is no file to resolve it against. Absolute references still work. For compatibility, relative `files`, `vocabularies` and `resourceTemplates` sources of such a blueprint keep resolving against the Playground page, as before. Media URLs (`items[].media[].url`) always resolve against the Playground page.

## Vocabularies

`vocabularies` imports RDF vocabularies with Omeka's RDF importer, as **Vocabularies › Import new vocabulary** does:

```json
{
  "vocabularies": [
    {
      "prefix": "lrmi",
      "namespaceUri": "http://purl.org/dcx/lrmi-terms/",
      "label": "LRMI",
      "format": "turtle",
      "source": "https://www.dublincore.org/specifications/lrmi/lrmi_terms/2022-06-14/lrmi-terms.ttl"
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `source` | Required. URL or relative path of the RDF file |
| `namespaceUri`, `prefix`, `label` | Required. How the vocabulary appears in Omeka S |
| `comment` | Vocabulary comment |
| `format` | `guess` (the default; `auto` means the same), `rdfxml`, `turtle`, `ntriples`, `jsonld`, or any other format name of the importer |
| `lang` | Preferred language of labels and comments |
| `labelProperty`, `commentProperty` | Full URIs of the RDF properties to read labels and comments from |

- The source is downloaded by the worker, directly first (RDF hosts such as schema.org and dublincore.org allow CORS) and through the add-on proxy otherwise, and cached under `/persist`, so a reload does not download it again. Change the URL to get a new version.
- A vocabulary whose **namespace URI** already exists is left as it is, whatever its prefix or label. That is what makes reloads idempotent, and why the vocabularies Omeka installs itself (`dcterms`, `dctype`, `bibo`, `foaf`) do not need to be declared.
- A different vocabulary that already uses the same prefix makes the import fail, as in the admin form.
- A failed download, invalid RDF, or an RDF file without terms in `namespaceUri` stops the boot with the vocabulary and its source.
- Existing vocabularies are not updated from a newer file (Omeka-S-Cli does that only with `--update`).

## Resource templates

`resourceTemplates` imports resource-template JSON exports (**Resource templates › Export**):

```json
{
  "resourceTemplates": [
    { "source": "./templates/book.json" },
    { "source": "./templates/book.json", "label": "Book (copy)", "ignoreDeps": true }
  ]
}
```

| Field | Notes |
| --- | --- |
| `source` | Required. URL or relative path of the export |
| `label` | Label to use instead of the export's `o:label` |
| `ignoreDeps` | Import even when this installation lacks some of the template's vocabularies, classes, properties or data types; those are left out |

- The export is checked and matched with Omeka's own import code (the admin **Import** form): a file that is not a valid export stops the boot.
- Classes and properties are matched by namespace URI and local name, never by database id, so the templates can use the vocabularies declared in the same blueprint.
- Data types are kept when they are registered in this installation (core or module data types). Without `ignoreDeps`, any missing class, property or data type stops the boot with the list of what is missing. With it, the template is imported without them and a warning lists them.
- A template whose **label** (after `label` overrides it) already exists is left as it is, so reloads are idempotent and the user's edits are kept.

## Provisioning order

On every boot, after Omeka S is installed:

1. Modules and themes are downloaded; modules are installed and activated (with a fresh PHP boot after each module, as module activation requires).
2. `files` are placed.
3. `vocabularies`, then `resourceTemplates`, once every module is active (so their data types are registered) and before anything that could use their properties.
4. `users` and their settings, then `sites` and their permissions.
5. `settings`, last, so neither a module nor the sites (`default_site`) override them. This is Omeka-S-Cli's order.
6. `itemSets` and `items`, only on the first boot of a scope.

Steps 1 to 5 run on every boot and find what already exists, so a reload neither duplicates nor resets it. Content (step 6) is seeded once per scope, so deleted or edited demo items stay as the user left them. Reset Playground, `?clean=1` or another blueprint starts again from a clean installation.

## Entry identity (duplicates)

When a list (after imports) holds two entries for the same thing, they collapse into the **first** one: the later entry is **shallow-merged** into it (each field it gives replaces the earlier value as a whole, the others are kept), and the entry keeps its first position, so module install order does not change. A warning is logged when the later entry changes something. The identity of an entry, as written and compared without case:

| List | Identity |
| --- | --- |
| `modules`, `themes` | `name` (or the name string) |
| `files` | `destination` |
| `vocabularies` | `namespaceUri` |
| `resourceTemplates` | `label`, or `source` without a label |
| `users` | `email` |
| `sites` | `slug`, or `title` without a slug |
| `itemSets`, `items` | `title` |

```json
"modules": [
  { "$import": "./modules.base.json" },
  { "name": "Common", "version": "3.4.72" }
]
```

Here `Common` keeps the place and the `state` the imported file gave it, and only its version changes.

These rules are what Omeka-S-Cli 0.18 implements and what [omeka-s-contrib/omeka-s-blueprints#10](https://github.com/omeka-s-contrib/omeka-s-blueprints/issues/10) proposes. The published `v0` specification only says that the later entry applies, so they may still change; the table lives in `ENTRY_IDENTITY` (`src/shared/blueprint.js`).

## Schema validation

The shell validates a blueprint against a local copy of the shared `v0` schema before booting it, so no schema is fetched at boot:

- As in Omeka-S-Cli, the blueprint is validated once its imports are resolved, together with the cross-references a schema cannot express: an item set named by an item must be declared, a site slug may only contain letters, digits, `_` and `-`, a site theme must be declared in `themes` (`default` always is), and a site permission must name a user of `users` or `install.admin`.
- A blueprint whose `$schema` is the shared `v0` schema (or a `v0.x.y` release) must pass: any error stops the boot as a `BlueprintSchemaError` listing them, and every `$import`ed file is also checked on its own against the schema of its list, with its URL in the message.
- Other blueprints (the [legacy format](#legacy-format), or no `$schema`) only get a console warning, so the legacy keys keep working.
- The editor shows the same errors while you type (the cross-references only when the blueprint has no `$import` to fetch).
- Errors that the schema cannot see (a download that fails, a cycle, a relative import without a base URL) are reported as `BlueprintImportError`; errors while provisioning Omeka S (an RDF file that does not parse, a template that needs a missing vocabulary) are reported by the runtime with the blueprint entry. Each is reported once, separately.

`npm run build-worker` bundles the validator (Ajv) into `dist/blueprint-schema.bundle.js`. To refresh the local copy after a new `v0.x.y` release, download the published `schema/v0/blueprint-schema.json` over `assets/blueprints/shared/v0/blueprint-schema.json`.

## Support matrix

What the Playground does with each top-level key of the shared format (`v0`):

| Key | Support | Notes |
| --- | --- | --- |
| `$schema` | Supported | Selects strict validation for the shared schema |
| `meta`, `preferredVersions` | Supported | `preferredVersions` picks the runtime when the URL does not |
| `install` | Supported | `install.admin` is the first user and the autologin account; without one, the configured administrator is |
| `modules`, `themes` | Supported | ZIP URL, local ZIP, GitHub and omeka.org catalog sources; other git hosts and schemes are rejected |
| `files` | Supported | |
| `vocabularies` | Supported | All fields; see [Vocabularies](#vocabularies) |
| `resourceTemplates` | Supported | All fields; see [Resource templates](#resource-templates) |
| `settings` | Supported | Map or list, with imports |
| `users` | Supported | Role `author` and display name = email by default, as in Omeka-S-Cli; a user without `password` gets the configured password |
| `sites` | Supported | With `$import`, as Omeka-S-Cli does |
| `itemSets`, `items` | Supported | Seeded once per scope; media of type `url` |
| `$import` | Supported | Every list the schema allows, and `sites`; see [Imports](#imports-import) |
| `x-playground` | Supported | Playground settings |
| Other `x-*` keys | Ignored | As the specification requires |
| Schema validation | Supported | Schema and cross-references, strict when `$schema` is the shared schema |

Since Omeka-S-Cli 0.18 the two read a blueprint the same way: JSONC, `$import` (in `sites` too), relative references and the rejection of absolute paths, duplicates merged into the first entry, vocabularies identified by namespace URI, local ZIP add-ons, and validation with cross-references. Differences that remain when one blueprint serves both:

- Omeka-S-Cli reads local files and keeps relative paths inside the blueprint's directory (`--root`); the Playground only reads URLs, so a relative path can go anywhere on the same host.
- Omeka-S-Cli does not create `itemSets` or `items`. The Docker image runs it with `--skip core`, so `install` comes from its environment variables there.
- Existing users: Omeka-S-Cli leaves them as they are; the Playground updates them on every boot (role, name, password), so autologin keeps working with the blueprint's credentials.
- Without `setAsDefault`, the Playground makes the first site the default; Omeka-S-Cli sets no default site.
- Omeka-S-Cli changes existing vocabularies, templates and sites, and site roles, with `--update`; the Playground never does.
- Omeka-S-Cli requires the Common module for resource templates; the Playground uses the core import code.

## Project-specific rules and conventions

These conventions come from the current implementation, not generic JSON style advice:

- `x-playground.landingPage` is normalized to start with `/`.
- Any role id is accepted, including roles added by modules (e.g. `guest`). As a Playground convenience, `admin` and `supervisor` are mapped to `global_admin` and `site_admin`.
- Addon names must be a single path segment; slashes and traversal-like names are rejected.
- Remote addon URLs are absolutized against the current page URL.
- `modules[].state` supports `download` (place files only), `install`, and `activate` (default).
- `modules[].version` and `themes[].version` select the omeka.org release, or the tag/branch of a GitHub source.
- Repeated entries follow [Entry identity](#entry-identity-duplicates): they are merged into the first occurrence, which keeps its position.
- `items[].media[].type` currently supports `url`.
- Exactly one site is forced to be the default (the first one if none is flagged).
- `sites[].permissions[].role` is clamped to one of `viewer`, `editor`, `admin` (defaults to `viewer`); a permission whose `user` email matches no created user is skipped with a warning.
- A site slug that Omeka S would not accept is turned into a valid one for blueprints in the earlier format; the shared format reports it as an error.
- `items[].sites` entries match a site slug or title, without case; items with no match fall back to the default site.
- `users[].settings` keys are written verbatim to `user_setting`; values are stored as-is.

If you change the semantics of any of those rules, update both the schema and the documentation together.

## How to validate changes

1. Edit the blueprint JSON.
2. Validate it against the [`v0` schema](https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json): editors do it from `$schema`, and the Playground editor and shell do it too (see [Schema validation](#schema-validation)).
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
