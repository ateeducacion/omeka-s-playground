# `blueprint.json`

## What it is

In this repository, `blueprint.json` is the portable description of the initial Omeka S state that should exist inside a playground scope.

The default file is:

`assets/blueprints/default.blueprint.json`

It is inspired by WordPress Playground blueprints, but it is **not** the upstream WordPress schema. The authoritative implementation for this project is:

- schema: `assets/blueprints/blueprint-schema.json`
- normalization logic: `src/shared/blueprint.js`

## How the repository uses it

The shell loads a blueprint, normalizes missing values, and stores the active version for the current scope. The runtime then consumes that normalized blueprint during boot to:

- set install metadata such as title, locale, and timezone
- create and authenticate the primary admin account
- create additional users
- install or activate modules and themes
- create item sets, items, and media
- create a default public site
- choose the landing page after boot

Because the blueprint influences first-boot behavior, a small JSON change can alter installation, login, routing, or demo content.

## Structure used by this project

The most important top-level properties are:

| Property | Purpose | Notes |
| --- | --- | --- |
| `$schema` | Editor/schema reference | Point at the repository schema when possible |
| `meta` | Human-readable metadata | Good place for title, author, and description |
| `preferredVersions` | Informational runtime targets | Useful for intent, not a strict installer lockfile |
| `debug.enabled` | Enables development-style diagnostics | Helpful for install/debug sessions |
| `landingPage` | Initial post-boot path | Should usually begin with `/` |
| `siteOptions` | Install-wide defaults | Title, locale, timezone |
| `login` | Credentials used by autologin | Usually mirror the first user |
| `users` | Omeka users to create | First user becomes the effective admin source |
| `themes` | Themes to install | Supports bundled, URL, and `omeka.org` sources |
| `modules` | Modules to install or activate | Module names must stay unique |
| `itemSets` | Collections created before items | Referenced by item titles later |
| `items` | Sample resources and media | Media currently uses URL sources |
| `site` | Default public site | Optional but recommended for demos |

## Example

```json
{
  "$schema": "./assets/blueprints/blueprint-schema.json",
  "meta": {
    "title": "Demo classroom blueprint",
    "author": "ateeducacion",
    "description": "Creates a reusable demo site with sample media."
  },
  "debug": {
    "enabled": false
  },
  "landingPage": "/admin",
  "siteOptions": {
    "title": "Classroom Demo",
    "locale": "es",
    "timezone": "Atlantic/Canary"
  },
  "login": {
    "email": "admin@example.com",
    "password": "password"
  },
  "users": [
    {
      "username": "admin",
      "email": "admin@example.com",
      "password": "password",
      "role": "global_admin"
    }
  ],
  "themes": [
    {
      "name": "Foundation",
      "source": { "type": "omeka.org", "slug": "foundation-s" }
    }
  ],
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
  "site": {
    "title": "Demo Site",
    "slug": "demo-site",
    "theme": "Foundation",
    "setAsDefault": true
  }
}
```

## How to write and maintain it well

### Keep it readable

- Prefer one clear responsibility per section.
- Keep related values grouped together instead of scattering overrides.
- Use descriptive `meta.title` and `meta.description` values so future contributors understand intent immediately.

### Keep it stable

- Prefer bundled addons or known-good `omeka.org` slugs before remote ZIP URLs.
- Avoid duplicate module or theme names; `src/shared/blueprint.js` rejects duplicates.
- Keep `landingPage` simple and explicit. `/admin` is the safest default for contributor-oriented blueprints.

### Keep it maintainable

- Treat the first user as the canonical admin account because normalization uses it to derive effective admin config.
- Keep `login` aligned with the first user unless you have a strong reason not to.
- Use a small number of representative sample items instead of large demo datasets that slow down resets and reviews.
- Prefer relative media URLs for repository-bundled samples when possible.

## Project-specific rules and conventions

These conventions come from the current implementation, not generic JSON style advice:

- `landingPage` is normalized to start with `/`.
- User roles such as `admin` and `supervisor` are normalized to Omeka roles like `global_admin` and `site_admin`.
- Addon names must be a single path segment; slashes and traversal-like names are rejected.
- Remote addon URLs are absolutized against the current page URL.
- `modules[].state` currently supports `install` and `activate`.
- `items[].media[].type` currently supports `url`.

If you change the semantics of any of those rules, update both the schema and the documentation together.

## How to validate changes

1. Edit the blueprint JSON.
2. Compare it with `assets/blueprints/blueprint-schema.json`.
3. Start the app and trigger a clean boot by importing the blueprint or using a new scope.
4. Confirm the expected landing page, users, modules, themes, and sample content appear.
5. If something fails during boot, temporarily enable `debug.enabled`.

Useful targeted checks:

```bash
node --check src/shared/blueprint.js
node --check src/runtime/bootstrap.js
```

## Common mistakes to avoid

- **Using the upstream WordPress Playground schema as if it were identical.** This repository implements its own Omeka-specific blueprint format.
- **Adding hidden assumptions to runtime code instead of the blueprint.** That makes the setup harder to reason about.
- **Leaving `login` out of sync with the first user.** Autologin can become confusing.
- **Using fragile remote ZIP URLs.** If the URL needs unusual redirects or post-install steps, it may not work in-browser.
- **Overloading the blueprint with too much sample content.** Large initial datasets slow resets and make review harder.

## Troubleshooting

### The playground boots but lands on the wrong page

Check `landingPage`, current shell session state, and whether autologin bypassed a saved `/login` path.

### A module or theme does not install

Verify the addon `name`, the `source` definition, and whether the remote host is compatible with the configured proxy and outbound HTTP policy.

### Media fails to load

Confirm the URL resolves correctly from the deployed base path or local dev server. Relative sample paths are resolved against the current page URL.

### A blueprint import appears to do nothing

The shell only applies imported data after parsing and normalization. Check the browser console, shell logs, and whether the payload is valid JSON/base64url for `blueprint-data`.
