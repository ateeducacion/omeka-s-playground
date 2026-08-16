---
id: ADR-0029
title: "Timestamped Build IDs for deployment identification and cache versioning"
status: Proposed
date: 2026-08-16
---

# ADR-0029: Timestamped Build IDs for deployment identification and cache versioning

## Context

Omeka S Playground ships a rolling release: `main` deploys continuously to GitHub
Pages and Cloudflare Pages, so there is no release train to attach a semantic
version to. Two things still need an identifier for the *deployed artifact*: a bug
report has to name the exact build it came from, and a redeploy must not leave a
returning browser serving a previous build's assets.

A partial mechanism already existed under a different name. `scripts/esbuild.worker.mjs`
hashed the freshly built `dist/php-worker.bundle.js` and wrote the first 12 hex
characters into `src/generated/build-version.js`, which `sw.js` imports for its
`omeka-static-…` cache name and the shell uses for the `sw.js?v=…` registration,
the versioned worker URL and the Sentry `release`.

That identifier has three problems:

1. **It cannot distinguish two builds of the same source.** The hash only covers
   the worker bundle, so rebuilding an unchanged commit — or changing anything
   outside the bundle, such as the shell, an Omeka core bundle or a blueprint —
   yields the same value.
2. **It was committed to git.** The generated file was tracked, so every worker
   change produced a churn commit and the checked-in value was routinely stale.
3. **It carries no provenance.** There is no build time, no commit, no dirty flag,
   and nothing machine-readable is published with the deployed site.

## Decision

Replace the content hash with a **Build ID** in the canonical format shared by all
the sibling playgrounds:

```text
YYYYMMDDTHHMMSSZ-<sha8>[-dirty]
```

for example `20260816T065012Z-9e39f37d`. The timestamp is the UTC **build** time,
never the commit time, so a rebuild of unchanged source still yields a new ID.

1. `scripts/lib/build-version.mjs` owns the format (compose, parse, validate,
   resolve) as the single source of truth. `scripts/write-build-version.mjs`
   (`npm run build:version`) is a thin CLI over it that writes
   `src/generated/build-version.js` and `assets/build-version.json`;
   `--print-version` prints the ID without writing.
2. Remove the content-hash generation from `scripts/esbuild.worker.mjs` — one
   mechanism, not two competing ones — and untrack `src/generated/build-version.js`.
   Both generated files are now git-ignored, so no identifier is maintained by hand.
3. `BUILD_VERSION` overrides the ID outright; `BUILD_SHA` overrides only the
   revision. The `Deploy Pages` workflow computes the ID once and exports it via
   `$GITHUB_ENV`, so every later step in that job reuses the exact value — including
   the second `make prepare` triggered by `make bundle-all`. Because that single job
   assembles one `_site` that is both uploaded as the Pages artifact and deployed to
   Cloudflare, both targets necessarily report the same Build ID. `BUILD_SHA` is set
   to `github.event.pull_request.head.sha || github.sha` so pull request builds stay
   traceable to the source commit rather than the merge commit `actions/checkout`
   resolves.
4. Local builds derive the SHA from git and append `-dirty` for an unclean tree.
5. Existing cache wiring is kept as-is and simply carries the new value: the
   `omeka-static-…` Service Worker cache and its activation cleanup, the
   `sw.js?v=…` registration, and the versioned worker URL. No query-string
   versioning is added to individual CSS/JS URLs — the shell loads native ES
   modules, so versioning an entry point would leave its import graph unversioned;
   the Service Worker cache namespace covers the whole graph instead.
6. The Build ID is surfaced as a copyable "Playground build" row in the Runtime
   info panel, logged once at startup, and remains the Sentry `release` (ADR-0028).

The Build ID names the Playground artifact only. The Omeka S version and PHP
version running inside it stay separate, independently displayed values.

## Consequences

- A bug report that quotes a Build ID pins the exact artifact, its build time and
  its source commit; `assets/build-version.json` exposes the same data to tooling.
- Redeploys reliably invalidate the Service Worker cache, which the content hash
  did only when the worker bundle itself changed.
- `src/generated/build-version.js` no longer appears in diffs.
- Every deploy now creates a new cache generation, so a returning visitor
  re-downloads the cached `/dist/` assets once per deploy — previously they were
  reused across deploys that did not touch the worker bundle. This is the intended
  trade: correctness over a saved download.
- `make prepare` and `make test` gained a `build-version` prerequisite, since the
  generated module is no longer committed.
- Persistent user data is deliberately not keyed by the Build ID: the IndexedDB
  journal stays keyed by scope, so deploying does not wipe a visitor's site.

## Validation

- `tests/build-version.test.mjs` pins the format, the 8-character SHA, the metadata
  fields, the `BUILD_VERSION`/`BUILD_SHA` overrides, dirty handling and that two
  build times for one commit produce different IDs. Time and git are injected, so
  the suite never depends on the wall clock.
- `tests/e2e/shell.spec.mjs` asserts the served `assets/build-version.json` is
  canonical and matches the ID rendered in the info panel.
