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
