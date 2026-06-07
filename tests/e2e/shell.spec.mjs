import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

async function waitForRuntimeReady(page) {
  // The address bar stays disabled until the PHP runtime has booted and the
  // site frame is scoped — booting requires the core bundle to have been
  // extracted into MEMFS (now via PHP ZipArchive), so this also guards against
  // a core-extraction regression making boot too slow / fail. The runtime-id
  // chip in the Info panel is populated as soon as the runtime is selected, so
  // it doubles as a readiness signal.
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
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

test("info panel hosts the version config with a dirty-state apply", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // The floating settings popover and gear button are gone — the version config
  // now lives in the Info panel (single source of truth).
  await expect(page.locator("#settings-button")).toHaveCount(0);
  await expect(page.locator("#settings-popover")).toHaveCount(0);

  await page.locator("#panel-toggle-button").click();

  const omekaOptions = await page.locator("#info-omeka-version option").count();
  expect(omekaOptions).toBeGreaterThan(0);
  const phpOptions = await page.locator("#info-php-version option").count();
  expect(phpOptions).toBeGreaterThan(0);

  // Clean state: no Apply button and no destructive warning.
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-warning")).toBeHidden();

  // Changing a version reveals the Apply button + the warning. Reselecting the
  // original value clears the dirty state (no Discard button needed). Prefer the
  // Omeka select if it offers more than one version, else fall back to PHP.
  const omekaCurrent = await page.locator("#info-omeka-version").inputValue();
  const omekaOther = await page
    .locator("#info-omeka-version option")
    .evaluateAll(
      (opts, cur) => opts.find((o) => o.value !== cur)?.value,
      omekaCurrent,
    );
  const dirtySelect = omekaOther ? "#info-omeka-version" : "#info-php-version";
  const current = await page.locator(dirtySelect).inputValue();
  const other = await page
    .locator(`${dirtySelect} option`)
    .evaluateAll(
      (opts, cur) => opts.find((o) => o.value !== cur)?.value,
      current,
    );

  expect(other).toBeTruthy();
  await page.locator(dirtySelect).selectOption(other);
  await expect(page.locator("#config-apply")).toBeVisible();
  await expect(page.locator("#config-warning")).toBeVisible();

  await page.locator(dirtySelect).selectOption(current);
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-warning")).toBeHidden();
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

test("seeds blueprint content only once (content marker is journaled)", async ({
  page,
}) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // Seed-once writes /persist/runtime/content-seeded.json after the first
  // provisioning; on every later boot the installer sees it and skips re-seeding,
  // so a deleted blueprint item stays deleted. Before the fix that marker did not
  // exist and the installer re-created blueprint content on every boot. Asserting
  // the marker is journaled proves the gate is active (and fails on the old code).
  // Wait past the 1500ms debounced flush so boot's writes reach IndexedDB.
  await page.waitForTimeout(2500);

  const marker = await page.evaluate(async () => {
    const meta = (await indexedDB.databases()).find((d) =>
      d.name?.startsWith("omeka-fs-journal:"),
    );
    if (!meta) return { error: "no journal db" };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(meta.name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const ops = await new Promise((res, rej) => {
      const rq = db.transaction("ops", "readonly").objectStore("ops").getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    const seeded = ops.some((op) => {
      const p = typeof op?.path === "string" ? op.path : JSON.stringify(op);
      return p.includes("/persist/runtime/content-seeded.json");
    });
    return { total: ops.length, seeded };
  });

  expect(marker.error).toBeUndefined();
  // Positive control: real data is journaled.
  expect(marker.total).toBeGreaterThan(0);
  // The fix: the content-seeded marker is persisted, so re-seeding is skipped.
  expect(marker.seeded).toBe(true);
});
