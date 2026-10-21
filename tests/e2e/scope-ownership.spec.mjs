import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 300_000 });
const prefix = "omeka-playground";

async function ready(page) {
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: 180_000,
  });
  const frame = page.frameLocator("#site-frame").frameLocator("#remote-frame");
  await expect(frame.locator("body")).toContainText(/Omeka|Dashboard/, {
    timeout: 60_000,
  });
}

function heldLocks(page) {
  return page.evaluate(async () =>
    (await navigator.locks.query()).held.map((lock) => lock.name),
  );
}

// URLs of the PHP workers serving `scope` in every open tab. A remote host
// starts its worker only after it owns the scope, so more than one means a
// POST on the scope's bridge would run twice.
function phpWorkers(context, scope) {
  return context
    .pages()
    .flatMap((page) => page.workers())
    .map((worker) => worker.url())
    .filter((href) => {
      const url = new URL(href);
      return (
        url.pathname.endsWith("/php-worker.bundle.js") &&
        url.searchParams.get("scope") === scope
      );
    });
}

async function postOnce(page, scope, oldId = null) {
  return page.frame({ url: /remote\.html/u }).evaluate(
    async ({ prefix, scope, oldId }) => {
      const name = `${prefix}-php:${scope}`;
      const channel = new BroadcastChannel(name);
      // A new BroadcastChannel joins its channel asynchronously. Wait until a
      // message posted after it was created reaches it, so the probe's request
      // and reply cannot be broadcast before this channel listens.
      const ping = new BroadcastChannel(name);
      await new Promise((resolve) => {
        channel.onmessage = ({ data }) => {
          if (data?.kind === "ownership-probe-listening") resolve();
        };
        ping.postMessage({ kind: "ownership-probe-listening" });
      });
      ping.close();
      let id;
      const replies = [];
      let replied;
      const reply = new Promise((resolve) => {
        replied = resolve;
      });
      channel.onmessage = ({ data }) => {
        if (
          data.kind === "http-request" &&
          data.request.url.includes("ownership-probe")
        ) {
          id = data.id;
          if (oldId)
            channel.postMessage({
              kind: "http-response",
              id: oldId,
              response: {
                status: 200,
                headers: {},
                body: new TextEncoder().encode("stale-reply"),
              },
            });
        }
        if (data.kind === "http-response" && data.id === id) {
          replies.push(data.id);
          replied();
        }
      };
      const source = new URL(document.querySelector("#remote-frame").src);
      const root = source.pathname.match(
        /^(.*\/playground\/[^/]+\/[^/]+)\//u,
      )[1];
      const response = await fetch(`${root}/config.php?ownership-probe=1`, {
        method: "POST",
        body: "probe=1",
      });
      const body = await response.text();
      // The Service Worker answers from a bridge reply, which every channel
      // receives. Wait for this channel's copy instead of a fixed delay; the
      // bound only turns a missing reply into a readable failure.
      await Promise.race([
        reply,
        new Promise((resolve) => setTimeout(resolve, 30_000)),
      ]);
      channel.close();
      return { replies, id, body, status: response.status };
    },
    { prefix, scope, oldId },
  );
}

async function expectSingleReply(page, scope) {
  const result = await postOnce(page, scope);
  expect(result.replies, JSON.stringify(result)).toHaveLength(1);
}

for (const differentRuntime of [false, true]) {
  test(`a shared scope executes POST once (${differentRuntime ? "different" : "same"} runtime)`, async ({
    page,
    context,
  }) => {
    const scope = `ownership-${crypto.randomUUID()}`;
    await page.goto(`/?scope=${scope}`);
    await ready(page);
    const firstRuntime = await page.locator("#runtime-id-value").textContent();
    const second = await context.newPage();
    await second.addInitScript(
      ({ prefix, scope, runtimeId }) => {
        sessionStorage.setItem(
          `${prefix}:${scope}:state`,
          JSON.stringify({ runtimeId }),
        );
      },
      {
        prefix,
        scope,
        runtimeId: differentRuntime ? "php84-omeka421" : firstRuntime,
      },
    );
    await second.goto(`/?scope=${scope}${differentRuntime ? "&php=8.4" : ""}`);
    // Baseline boots a second PHP runtime. Fixed code rejects it before storage/worker startup.
    await expect
      .poll(
        async () => {
          const status = await second
            .frameLocator("#site-frame")
            .locator("#remote-status")
            .textContent();
          return (
            status.includes("already open") ||
            (await second.locator("#address-input").isEnabled())
          );
        },
        { timeout: 180_000 },
      )
      .toBe(true);
    expect(phpWorkers(context, scope)).toHaveLength(1);
    const result = await postOnce(page, scope);
    expect(result.replies, JSON.stringify(result)).toHaveLength(1);
    await expect(
      second.frameLocator("#site-frame").locator("#remote-status"),
    ).toContainText("already open");
    expect(second.workers()).toHaveLength(0);
    await expect(page.locator("#address-input")).toBeEnabled();
    await page
      .locator("#site-frame")
      .evaluate((frame) =>
        frame.contentWindow.postMessage(
          { kind: "flush-persistence" },
          location.origin,
        ),
      );
    await expect(page.locator("#log-panel")).toContainText(
      "Persistence journal flushed",
    );
    await page.close();
    // Closing a tab releases its Web Lock asynchronously: reload only once the
    // scope is free, or the reloaded tab is rejected as a second owner again.
    await expect
      .poll(() => heldLocks(second))
      .not.toContain(`${prefix}-owner:${scope}`);
    await second.reload({ waitUntil: "commit" });
    await ready(second);
    expect(await heldLocks(second)).toContain(`${prefix}-owner:${scope}`);
    expect(phpWorkers(context, scope)).toHaveLength(1);
    const afterHandover = await postOnce(second, scope, result.id);
    expect(afterHandover.replies, JSON.stringify(afterHandover)).toHaveLength(
      1,
    );
    expect(afterHandover.body).not.toBe("stale-reply");
  });
}

test("distinct scopes remain independent across reload and Reset", async ({
  page,
  context,
}) => {
  const scope = `independent-${crypto.randomUUID()}`;
  const other = `independent-${crypto.randomUUID()}`;
  await page.goto(`/?scope=${scope}`);
  await ready(page);
  const second = await context.newPage();
  await second.goto(`/?scope=${other}`);
  await ready(second);
  expect(phpWorkers(context, scope)).toHaveLength(1);
  expect(phpWorkers(context, other)).toHaveLength(1);
  await expectSingleReply(page, scope);
  await expectSingleReply(second, other);
  await second
    .locator("#site-frame")
    .evaluate((frame) =>
      frame.contentWindow.postMessage(
        { kind: "flush-persistence" },
        location.origin,
      ),
    );
  await expect(second.locator("#log-panel")).toContainText(
    "Persistence journal flushed",
  );
  await second.reload({ waitUntil: "commit" });
  await ready(second);
  const previous = second
    .frames()
    .find((frame) => frame.url().includes("/playground/"));
  await second.locator("#panel-toggle-button").click();
  await second.locator("#reset-button").click();
  await expect.poll(() => previous.isDetached()).toBe(true);
  await ready(second);
  // The old host's worker is terminated before the new owner starts its own.
  await expect.poll(() => phpWorkers(context, other).length).toBe(1);
  await expectSingleReply(second, other);
  await expectSingleReply(page, scope);
});
