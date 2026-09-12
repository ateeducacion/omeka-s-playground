# AGENTS.md — Omeka S Playground

Read only the guidance relevant to the task. Keep repository-wide constraints here;
put domain details in the existing skills and documentation. If a guide disagrees
with the implementation, verify the current code before restoring old behavior.

## Working conventions

- Branch names must be English and start with `feature/` or `hotfix/`; rename
  nonconforming branches before pushing or opening a PR. Never use `codex/`.
- For library/API/CLI questions, resolve the library in Context7 and query current
  documentation. General code review and business-logic refactoring do not need it.
- Complete requested edits and relevant local verification without asking between
  routine steps. Report what was checked and any blocker.
- Keep ESM and the existing path helpers: URL paths and POSIX filesystem paths
  are different. Do not add framework dependencies without an explicit requirement.

## Runtime and build map

Omeka S runs through the shell, remote host, Service Worker, bundled PHP worker,
and `src/runtime/{php-loader,php-compat,bootstrap,vfs}.js`.
`scripts/dev-server.mjs` serves the static app and local addon proxy; production
uses the external proxy configured in `playground.config.json`.

| Task | Command |
|------|---------|
| Prepare dependencies/runtime/worker | `make prepare` |
| Build one version | `make bundle OMEKA_VERSION=<version>` |
| Build supported versions | `make bundle-all` |
| Build and serve | `make up` |
| Serve existing assets | `make serve` (port 8080) |

Use Node >= 22.15 for native zstd bundle building, npm, Composer, and Git.
Versions and sources live in `src/shared/omeka-versions.js`; keep matching Make
version targets when adding a release. The core bundle is streaming `tar.zst`,
not ZIP; see [bundle design](docs/streaming-tar-zst-bundle.md). Keep the build script,
manifest generator, and `src/runtime/vfs.js` aligned when changing its format.
Generated output lives in `assets/omeka/`, `assets/manifests/`, and `dist/`.

## Omeka invariants

- Core lives at `/www/omeka`; mutable uploads are `/persist/mutable/files`, the DB
  is `/persist/mutable/db/omeka.sqlite`, and remote addons are `/persist/addons`,
  linked into core `modules/` or `themes/`. Preserve that split.
- `omeka-fs-journal:<scope>` persists `/persist`. OPcache is enabled for runtime
  use but intentionally not journaled. See `src/runtime/fs-persistence.js`.
- Install and content seeding are idempotent. Ordinary reload must not recreate
  edited/deleted demo content; preserve `/persist/runtime/content-seeded.json`.
  Reset clears that marker along with the mutable journal so content can reseed.
- Initialize Omeka with `bootstrap.php`, not only Composer's autoloader. Module
  activation can require continuation boots before its services/roles are usable.
- Keep jobs synchronous and the spawn bridge allowlisted and recursion-bounded.
  ImageMagick/native subprocesses are unavailable; use the configured thumbnailer.
- Production commonly lives under `/omeka-s-playground`. Omeka emits escaped URLs
  such as `&#x2F;admin&#x2F;site`; preserve their rewriting in `sw.js`.
- Autologin must tolerate failed credentials and stale saved login paths. When
  changing it, verify clean boot and reload through the real admin UI.
- Browser API writes require API keys. Use authorized admin controllers with the
  CSRF token from the current form, or internal provisioning APIs; do not bypass auth.
- Changes to `outboundHttp`, `addonProxyPath`, or `addonProxyUrl` need checks of
  both local proxy and production proxy paths. PHP sockets do not provide arbitrary
  internet access; preserve proxy/allowlist policy and untrusted archive validation.
- Blueprint schema, `src/shared/blueprint.js`, runtime consumption, and
  [blueprint docs](docs/blueprint-json.md) form one contract; update them together.

Use [development](docs/development.md) for local workflow and
[WordPress Playground notes](docs/wordpress-playground.md) for upstream integration.
Keep public/event-entry functions before their helpers when adding related functions.
A reload may not settle at `load`; use the existing spec's reload/readiness pattern
(`waitUntil: "commit"` where needed), then wait for app content.

## Shared runtime constraints

- The shell's `#site-frame` hosts `remote.html`, which hosts `#remote-frame` for
  `/playground/<scope>/<runtime>/...`. Preserve root and subpath hosting, scoped
  redirects, query strings, and HTML-escaped links/forms when changing routing.
- PHP state and PDO connections reset per execution. SQLite must remain a file in
  MEMFS, never `:memory:`. Preserve the core/mutable separation; do not copy the
  entire core into persistent storage on boot.
- Mutable data is journaled to IndexedDB and restored for reloads. Scope normally
  comes from `sessionStorage`; new tabs normally get a new environment, while
  duplicated tabs or an explicit `?scope=` can reuse a scope. Closing a tab does
  not guarantee deletion of the underlying IndexedDB database.
- A different blueprint source or Reset Playground forces a clean boot; reloading
  the same blueprint retains the journal. Keep journaling active after clearing it.
  Source identity is defined in `src/shared/paths.js` and handled by the shell.
- Normalize journal operations before hydration to avoid copying every repeated
  SQLite write. Keep recovery checkpoints coherent; replay only safe GET/HEAD
  requests after a crash, with restart-loop guards intact.
- Worker and Service Worker changes, including their runtime/blueprint imports,
  require `npm run build-worker`. Clear Service Worker caches before manual
  verification; Reset Playground and `?clean=1` clear data, not stale code bundles.
- Keep the classic Service Worker bundle at the app root so its scope covers the
  application. Generated assets and bundles must not be hand-edited unless the
  task specifically concerns build output.

## Verification and debugging

Use `package.json`, `Makefile`, and `playwright.config.mjs` for current commands
and runner settings. `make test` runs Node unit tests; `make lint` checks code;
`make format` applies formatting; `npm run test:e2e` runs browser tests.
Run checks appropriate to the changed behavior. Documentation-only edits need
link/frontmatter checks; they do not require rebuilding PHP or running every E2E.

For runtime changes, verify clean boot, reload, and the affected UI flow. Reuse the
existing specs in `tests/e2e/`: an enabled `#address-input` is a shell readiness gate,
not proof that application content rendered. Check content in the nested
`#remote-frame` when that is the behavior under test. Default credentials and
runtime choices are in `playground.config.json`.

Do not run sibling playground tests against a shared port: `reuseExistingServer`
can connect tests to the wrong app. For an isolated external server use its own
`PORT`, `PLAYWRIGHT_BASE_URL`, and `PLAYWRIGHT_EXTERNAL_SERVER=1`.

## Skills

Load a skill when the task needs its guidance; apply only relevant checks.

| Skill | Use for |
|-------|---------|
| [omeka-s-internals](.agents/skills/omeka-s-internals/SKILL.md) | Application-specific PHP, install, plugins/addons, and provisioning |
| [wp-playground-php-wasm](.agents/skills/wp-playground-php-wasm/SKILL.md) | PHP runtime, adapters, ini, networking |
| [wasm-browser-runtime](.agents/skills/wasm-browser-runtime/SKILL.md) | MEMFS, extraction, journaling, routing/recovery |
| [e2e-playwright](.agents/skills/e2e-playwright/SKILL.md) | Playwright test authoring and debugging |
| [unit-testing](.agents/skills/unit-testing/SKILL.md) | Node unit tests and PHP generator checks |
| [security-audit](.agents/skills/security-audit/SKILL.md) | Application vulnerability audits |
| [github-actions-hardening](.agents/skills/github-actions-hardening/SKILL.md) | Writing or reviewing .github/workflows/*.yml |
| [playwright-cli](.agents/skills/playwright-cli/SKILL.md) | Terminal-driven browser exploration |

### Skill maintenance

Installed skills live in `.agents/skills/`; `.claude/skills/` contains symlinks to
those directories. Keep one copy. `gh skills` is an alias of `gh skill`.

```bash
gh skill list --scope project
gh skill update --dir .agents/skills --dry-run
gh skill add cloudflare/security-audit-skill security-audit --agent github-copilot
ln -s ../../.agents/skills/security-audit .claude/skills/security-audit
```

The three vendored skills are `security-audit` (cloudflare/security-audit-skill),
`github-actions-hardening` (github/awesome-copilot), and `playwright-cli`
(microsoft/playwright-cli). Keep their contents and `metadata.github-*` provenance
verbatim. Fix upstream and reinstall; do not edit the local copies. Domain skills
remain local and have no GitHub provenance.

The four technical skills (`wp-playground-php-wasm`, `wasm-browser-runtime`,
`e2e-playwright`, `unit-testing`) are shared from `ateeducacion/moodle-playground`
and installed with `gh skills`. Keep their installed content/provenance unchanged;
fix the source in Moodle, merge it, then update here through the normal PR flow.
Application-specific guidance belongs in [runtime references](.agents/references/php-wasm-runtime.md)
and [testing references](.agents/references/playground-testing.md), outside the
installed folders so updates cannot overwrite it. Domain/blueprint skills stay local.

To install or refresh a shared skill from the merged source, use its exact path:

```bash
gh skills install ateeducacion/moodle-playground .agents/skills/wp-playground-php-wasm --agent github-copilot --force
```

Use the corresponding path for each of the other three skills; do not install all
Moodle skills. Keep matching `.claude/skills/` symlinks to the installed directories.

`.github/workflows/update-agent-skills.yml` opens weekly update PRs. Review prompt
diffs as behavior changes. Scope manual updates to `.agents/skills` so unrelated
user skills are untouched. Keep in-house descriptions short and task-specific;
link to conditional details instead of copying manuals or volatile inventories.

Repository conventions override vendored guidance. For GitHub Actions,
first-party `actions/*` stay on major tags maintained by Dependabot; third-party
actions use commit SHAs with version comments. Apply requested hardening edits.
Use the CLI skill for terminal browser exploration, not its plan/generate flow
for test authoring. Do not install WordPress Blueprint skills: shared step names
hide incompatible schemas; this project's schema and blueprint docs are authoritative.

Maintainer preference: use `actions/checkout@v7` and
`devantler-tech/actions/update-agent-skills@v13.3.3`; prefer the floating major
`v13` when upstream provides it. These two actions are exceptions to SHA pinning.
