import { expect, test } from "@playwright/test";

// OPcache canary (ADR-0030 / ADR-0031). The OpcacheCanary module fixture ships
// canary.php under the web root: step 1 compiles a 10 s old target returning
// "v1" (old enough for OPcache to store its bytecode), step 2 rewrites the same
// path to return "v2" and includes it again. A live file cache that does not
// validate timestamps keeps answering "v1". Rows are `<php>[:opcache]`; PHP 8.5
// runs the cache regardless of the flag, PHP <= 8.4 only with `?opcache=1`.
// The `8.5` row proves the timestamp validation on the version where the cache
// is live by default; it needs playground-install.php to run with Omeka's
// error_reporting policy (see tests/e2e/php85-install-script.spec.mjs).
test.describe.configure({ timeout: 300_000 });

const ROWS = (process.env.OPCACHE_CANARY_MATRIX || "8.3,8.3:opcache,8.5")
  .split(",")
  .map((row) => row.trim())
  .filter(Boolean);

async function waitForRuntimeReady(page) {
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
  await expect(page.locator("#address-input")).toBeEnabled();
  await expect(page.locator("#site-frame")).toHaveAttribute("src", /scope=/);
}

function remoteFrame(page) {
  return page.frameLocator("#site-frame").frameLocator("#remote-frame");
}

// Fetch canary.php from inside remote.html, the frame the Service Worker
// controls, so the request is routed to the PHP worker like any site request.
async function canary(page, step) {
  const frame = page.frame({ url: /remote\.html/u });
  expect(frame, "remote.html frame").not.toBeNull();
  const text = await frame.evaluate(async (currentStep) => {
    const inner = document.querySelector("#remote-frame");
    const scoped = new URL(inner.getAttribute("src"), window.location.href);
    const root = scoped.pathname.match(/^(.*\/playground\/[^/]+\/[^/]+)\//u);
    const response = await fetch(
      `${root[1]}/modules/OpcacheCanary/canary.php?step=${currentStep}`,
      { cache: "no-store" },
    );
    return response.text();
  }, step);
  return JSON.parse(text);
}

for (const row of ROWS) {
  const [phpVersion, flag] = row.split(":");
  const opcache = flag === "opcache";

  test(`rewritten PHP files recompile on PHP ${phpVersion}${opcache ? " with ?opcache=1" : ""}`, async ({
    page,
    baseURL,
  }) => {
    const blueprint = {
      modules: [
        {
          name: "OpcacheCanary",
          source: new URL("/tests/e2e/fixtures/OpcacheCanary.zip", baseURL)
            .href,
        },
      ],
      "x-playground": { landingPage: "/admin/module" },
    };
    const payload = Buffer.from(JSON.stringify(blueprint)).toString(
      "base64url",
    );
    await page.goto(
      `/?php=${phpVersion}&blueprint=${payload}${opcache ? "&opcache=1" : ""}`,
    );
    await waitForRuntimeReady(page);
    await expect(page.locator("#runtime-id-value")).toContainText(
      `php${phpVersion.replace(".", "")}`,
    );
    // The module list proves the fixture was extracted and installed.
    await expect(remoteFrame(page).locator("body")).toContainText(
      "OPcache Canary",
    );

    const first = await canary(page, 1);
    expect(first.value).toBe("v1");
    expect(first.php.startsWith(`${phpVersion}.`)).toBe(true);

    // The canary itself: a live cache without timestamp validation answers v1.
    const second = await canary(page, 2);
    expect(second.value).toBe("v2");

    expect(second.validateTimestamps).toBe("1");
    expect(second.blacklist).toBe("/internal/shared/opcache-blacklist.txt");
    const cacheLive = opcache || phpVersion === "8.5";
    if (cacheLive) {
      expect(second.status).toMatchObject({ fileCacheOnly: true });
    } else {
      expect(second.status).toBe(false);
    }
    expect(second.sapi).toBe(opcache ? "uwsgi" : "wasm");
  });
}
