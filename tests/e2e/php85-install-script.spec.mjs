import { expect, test } from "@playwright/test";

// PHP 8.5 regression coverage for playground-install.php. PHP 8.5 deprecates
// PDO::sqliteCreateFunction(), which Doctrine DBAL 2 calls on every connect;
// with the loader's display_errors=On that message counted as sent output and
// PHP then refused ini_set('session.name') in Omeka's session bootstrap. The
// first install pass survived (no session setup before install), but every
// later run of the script against an installed database failed: the module
// continuation pass and every same-scope reload. Both are exercised here.
test.describe.configure({ timeout: 300_000 });

const PHP_VERSION = "8.5";

async function waitForRuntimeReady(page) {
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
  await expect(page.locator("#runtime-id-value")).toContainText(
    `php${PHP_VERSION.replace(".", "")}`,
  );
}

function remoteFrame(page) {
  return page.frameLocator("#site-frame").frameLocator("#remote-frame");
}

test(`installs a module from a blueprint on PHP ${PHP_VERSION}`, async ({
  page,
  baseURL,
}) => {
  // Installing a module makes the install script exit with the continuation
  // marker and run again against the now-installed database.
  const blueprint = {
    modules: [
      {
        name: "InsertIgnoreProbe",
        state: "activate",
        source: new URL("/tests/e2e/fixtures/InsertIgnoreProbe.zip", baseURL)
          .href,
      },
    ],
    "x-playground": { landingPage: "/admin/module" },
  };
  const payload = Buffer.from(JSON.stringify(blueprint)).toString("base64url");
  await page.goto(`/?php=${PHP_VERSION}&blueprint=${payload}`);
  await waitForRuntimeReady(page);
  await expect(remoteFrame(page).locator("body")).toContainText(
    "Insert Ignore Probe",
  );
});

test(`reboots from the persisted install on reload on PHP ${PHP_VERSION}`, async ({
  page,
}) => {
  await page.goto(`/?php=${PHP_VERSION}`);
  await waitForRuntimeReady(page);
  await expect(remoteFrame(page).locator("body")).toContainText(
    "Admin dashboard",
  );

  // Same pattern as shell.spec.mjs: wait past the debounced journal flush, then
  // reload in the same tab so the install script runs on the installed database.
  await page.waitForTimeout(2500);
  await page.reload();
  await waitForRuntimeReady(page);
  await expect(remoteFrame(page).locator("body")).toContainText(
    "Admin dashboard",
  );
});
