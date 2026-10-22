import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 300_000 });

async function ready(page) {
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: 180_000,
  });
}

function registrationState(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      active: registration?.active?.scriptURL ?? null,
      waiting: registration?.waiting?.scriptURL ?? null,
      installing: registration?.installing?.scriptURL ?? null,
    };
  });
}

// Issue #235: the script URL carried scope and runtime, so another tab with a
// different scope or runtime installed a new worker under the first one.
test("a tab with another scope and runtime keeps the same Service Worker", async ({
  page,
  context,
}) => {
  await page.goto(`/?scope=sw-a-${crypto.randomUUID()}`);
  await ready(page);
  const before = await registrationState(page);
  expect(before.active).toMatch(/\/sw\.bundle\.js\?v=[^&]+$/u);

  const second = await context.newPage();
  await second.goto(`/?scope=sw-b-${crypto.randomUUID()}&php=8.4`);
  await ready(second);

  expect(await registrationState(page)).toEqual(before);
  expect(await registrationState(second)).toEqual(before);
});
