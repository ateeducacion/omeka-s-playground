# Omeka S testing reference

Local details for the shared testing skills. Read only the relevant section.
This reference stays outside remotely installed skill directories.

## Unit tests

- Tests are tests/*.test.mjs; use make test or node --test with a specific file.
  They import source directly with node:test and node:assert/strict.
- Use blueprint.test.mjs and addons.test.mjs for Omeka-specific normalization and
  provisioning; install-script-boot.test.mjs covers the bootstrap entrypoint.
- spawn-handler.test.mjs protects command allowlisting; php-compat-response and
  html-url-rewrite tests cover response/routing behavior. Check fs-persistence
  and crash-recovery checkpoint tests for DB/upload consistency.

## E2E

- tests/e2e/shell.spec.mjs has a local waitForRuntimeReady helper using the enabled
  address bar and scoped #site-frame source. There is no Moodle helpers.mjs API.
  For app content, target #site-frame then #remote-frame and wait for real content.
- playwright.config.mjs owns timeouts and startup. The server command uses 8085;
  changing PLAYWRIGHT_BASE_URL alone does not change that command. For another
  port, start an external server and set PLAYWRIGHT_EXTERNAL_SERVER=1 plus its URL.
- Use npm run test:e2e or npx playwright test tests/e2e/shell.spec.mjs. Do not copy
  Moodle's browser-project names or PLAYWRIGHT_PORT setting into this repository.
- Reload tests must wait for relevant journal writes and assert retained app data.
  Reset/different blueprint source clears state. Storage policy is in
  [runtime reference](php-wasm-runtime.md).
- On Omeka, a reload can hang at load; if reproducing this, wait for commit and
  then poll readiness/content. The current shell spec uses page.reload(); do not
  claim a shared reload helper already exists.
