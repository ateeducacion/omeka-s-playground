import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

async function waitForRuntimeReady(page) {
  // The address bar stays disabled until the PHP runtime has booted and the
  // site frame is scoped — booting requires the core bundle to have been
  // extracted into MEMFS (now via PHP ZipArchive), so this also guards against
  // a core-extraction regression making boot too slow / fail.
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
}

test("boots the Omeka runtime and serves the scoped site frame", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);
});

test("toggles the runtime side panel", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#side-panel")).not.toHaveClass(/is-collapsed/);
});

test("persists /persist to IndexedDB and reboots from it on reload", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // The persistence layer opens an "omeka-fs-journal:<scopeId>" IndexedDB and
  // journals /persist (the SQLite DB + uploads). Its presence proves mutable
  // state is being persisted.
  const journaled = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name?.startsWith("omeka-fs-journal:"));
  });
  expect(journaled).toBeTruthy();

  // Wait past the 1500ms debounced flush so the journal holds the install, then
  // reload in the same tab (sessionStorage keeps the scopeId). The runtime must
  // boot again by replaying the persisted /persist — exercising the full
  // write→replay round-trip without re-running a clean install.
  await page.waitForTimeout(2500);
  await page.reload();
  await waitForRuntimeReady(page);
});
