import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import {
  buildDefaultBlueprint,
  encodeBlueprintParam,
  exportBlueprintPayload,
  SHARED_BLUEPRINT_SCHEMA_URL,
} from "../src/shared/blueprint.js";
import { OMEKA_VERSIONS } from "../src/shared/omeka-versions.js";
import {
  createShellChannel,
  SNAPSHOT_VERSION,
} from "../src/shared/protocol.js";
import {
  SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
  SERVICE_WORKER_UNSUPPORTED_MESSAGE,
} from "../src/shared/service-worker-support.js";
import {
  APP_BASE,
  installBrowser,
  moduleControl,
  waitFor,
} from "./helpers/shell-dom.mjs";

// main.js runs on import, so every boot imports a fresh copy (?boot=N). Its
// config loader memoizes the fetched config per module, so each boot also
// gets its own copy of src/shared/config.js.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const boot = context.parentURL?.match(
      /\/src\/shell\/main\.js(\?boot=\d+)$/u,
    );
    if (boot && specifier === "../shared/config.js") {
      const resolved = nextResolve(specifier, context);
      return { ...resolved, url: `${resolved.url}${boot[1]}` };
    }
    return nextResolve(specifier, context);
  },
});

const SCOPE = "s1";
const STATE_KEY = `omeka-playground:${SCOPE}:state`;
const DEFAULT_RUNTIME = "php83-omeka421";
let bootCount = 0;

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function boot(t, { query = "", wait = "frame", ...options } = {}) {
  moduleControl.codejar = "missing";
  const env = installBrowser(t, {
    url: `${APP_BASE}index.html?scope=${SCOPE}${query}`,
    ...options,
  });
  const frame = env.$("#site-frame");
  await import(`../src/shell/main.js?boot=${++bootCount}`);
  if (wait === "frame") {
    await waitFor(() => frame.getAttribute("src"), "remote frame");
  } else if (wait === "srcdoc") {
    await waitFor(() => frame.getAttribute("srcdoc"), "error page");
  } else if (typeof wait === "function") {
    await waitFor(() => wait(env), "boot");
  }
  env.frameUrl = () => new URL(frame.getAttribute("src"));
  return env;
}

async function bootReady(t, options) {
  const env = await boot(t, options);
  env
    .channel()
    .emit({ kind: "ready", path: env.frameUrl().searchParams.get("path") });
  return env;
}

function hidden(element) {
  return element.classList.contains("is-hidden");
}

function change(env, element) {
  element.dispatchEvent(new env.happy.Event("change"));
}

describe("shell boot", () => {
  it("registers the Service Worker and points the frame at the runtime", async (t) => {
    const env = await boot(t);

    assert.equal(env.registrations.length, 1);
    const sw = new URL(env.registrations[0].url);
    assert.equal(sw.pathname.endsWith("/sw.bundle.js"), true);
    assert.equal(sw.searchParams.get("v"), BUILD_VERSION);
    assert.equal(sw.searchParams.get("scope"), SCOPE);
    assert.equal(sw.searchParams.get("runtime"), DEFAULT_RUNTIME);
    assert.deepEqual(env.registrations[0].opts, {
      scope: "./",
      updateViaCache: "none",
    });

    const frameUrl = env.frameUrl();
    assert.equal(frameUrl.href.startsWith(`${APP_BASE}remote.html?`), true);
    assert.equal(frameUrl.searchParams.get("scope"), SCOPE);
    assert.equal(frameUrl.searchParams.get("runtime"), DEFAULT_RUNTIME);
    assert.equal(frameUrl.searchParams.get("path"), "/admin");
    assert.equal(frameUrl.searchParams.has("clean"), false);
    const instance = frameUrl.searchParams.get("instance");
    assert.equal(env.channel().name, createShellChannel(SCOPE, instance));

    assert.match(
      env.logText(),
      /Runtime selection: php=8\.3, omeka=4\.2\.1, runtime=php83-omeka421/u,
    );
    assert.match(
      env.logText(),
      new RegExp(`Playground build ${BUILD_VERSION}`, "u"),
    );
    assert.equal(env.$("#build-id-value").textContent, BUILD_VERSION);
    assert.equal(
      env.$("#build-id-chip").title,
      `Copy Playground build ID (${BUILD_VERSION})`,
    );
    assert.equal(env.$("#runtime-id-value").textContent, DEFAULT_RUNTIME);
    assert.equal(env.$("#address-input").value, "/admin");

    // Locked until the runtime reports ready.
    assert.equal(env.$("#address-input").disabled, true);
    assert.equal(env.$("#reset-button").disabled, true);
    assert.ok(env.$("#address-form").classList.contains("is-disabled"));

    // The default blueprint (assets/blueprints/default.blueprint.json) is in
    // the editor.
    const text = env.$("#blueprint-textarea").value;
    assert.equal(
      JSON.parse(text).meta.title,
      "Default Omeka S Playground Blueprint",
    );

    // Info panel selectors reflect the running versions.
    const omeka = env.$("#info-omeka-version");
    assert.deepEqual(
      [...omeka.options].map((o) => o.value),
      OMEKA_VERSIONS.map((v) => v.version),
    );
    assert.equal(omeka.value, "4.2.1");
    assert.equal(env.$("#info-php-version").value, "8.3");
    assert.equal(env.$("#info-opcache").checked, true);
    assert.equal(env.$("#config-status").textContent, "Running");
    assert.ok(hidden(env.$("#config-apply")));

    assert.match(
      env.$("#phpinfo-frame").srcdoc,
      /No PHP diagnostics captured yet/u,
    );
  });

  it("reloads once so the new Service Worker controls the page", async (t) => {
    const env = await boot(t, {
      serviceWorker: { controller: null },
      wait: (env) => env.location.reloads === 1,
    });
    assert.equal(
      env.window.sessionStorage.getItem(
        `omeka-playground:${SCOPE}:sw-controlled`,
      ),
      "1",
    );
    await flush();
    assert.equal(env.$("#site-frame").getAttribute("src"), null);
  });

  it("does not loop reloading when the page stays uncontrolled", async (t) => {
    const env = await boot(t, {
      serviceWorker: { controller: null },
      session: { [`omeka-playground:${SCOPE}:sw-controlled`]: "1" },
    });
    assert.equal(env.location.reloads, 0);
    assert.equal(
      env.window.sessionStorage.getItem(
        `omeka-playground:${SCOPE}:sw-controlled`,
      ),
      null,
    );
  });

  it("explains a missing Service Worker API instead of a blank frame", async (t) => {
    const env = await boot(t, { serviceWorker: false, wait: "srcdoc" });
    const frame = env.$("#site-frame");
    assert.match(frame.srcdoc, /The playground cannot start/u);
    assert.match(frame.srcdoc, /role="alert"/u);
    assert.equal(frame.getAttribute("src"), null);
    assert.match(env.logText(), /Service Workers are unavailable/u);
    assert.equal(hidden(env.$("#logs-panel")), false);
    assert.equal(env.$("#logs-tab").getAttribute("aria-selected"), "true");
    assert.equal(
      env.$("#side-panel").classList.contains("is-collapsed"),
      false,
    );
    assert.equal(
      env.$("#panel-toggle-button").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(env.$("#address-input").disabled, false);
    await waitFor(() => env.reports.length === 1, "report");
    assert.equal(env.reports[0].level, "warning");
    assert.equal(
      env.reports[0].message.formatted,
      SERVICE_WORKER_UNSUPPORTED_MESSAGE,
    );
    assert.equal(env.reports[0].extra.source, "service-worker-unsupported");
  });

  it("reports a failed registration and retries on the next navigation", async (t) => {
    const registerError = new Error("boom <script>");
    const env = await boot(t, {
      serviceWorker: { registerError },
      wait: "srcdoc",
    });
    const frame = env.$("#site-frame");
    assert.match(
      frame.srcdoc,
      /could not register its Service Worker: boom &lt;script&gt;/u,
    );
    await waitFor(() => env.reports.length === 1, "report");
    assert.equal(env.reports[0].extra.source, "service-worker-registration");
    assert.equal(env.reports[0].exception.values[0].value, "boom <script>");

    env.serviceWorker.registerError = null;
    env.$("#home-button").click();
    await waitFor(() => frame.getAttribute("src"), "retry");
    assert.equal(frame.getAttribute("srcdoc"), null);
    assert.equal(env.frameUrl().searchParams.get("path"), "/");
    assert.equal(env.registrations.length, 2);
  });

  it("logs a config load failure and unlocks the UI", async (t) => {
    const env = await boot(t, {
      fetchHandler: (url) =>
        url.endsWith("/playground.config.json")
          ? new Response("gone", { status: 503 })
          : null,
      wait: (env) =>
        /Unable to load playground config: 503/u.test(env.logText()),
    });
    assert.equal(env.$("#address-input").disabled, false);
    assert.equal(env.registrations.length, 0);
  });

  it("shows an invalid blueprint as the author's error, unreported", async (t) => {
    const encoded = await encodeBlueprintParam({
      $schema: SHARED_BLUEPRINT_SCHEMA_URL,
      modules: 5,
    });
    const env = await boot(t, {
      query: `&blueprint=${encoded}`,
      wait: (env) => /BlueprintSchemaError: /u.test(env.logText()),
    });
    assert.match(env.logText(), /modules must be array/u);
    await flush();
    assert.equal(env.reports.length, 0);
  });
});

describe("shell runtime selection", () => {
  it("restores the saved path; the blueprint's versions beat the saved runtime", async (t) => {
    // Every resolved blueprint carries preferredVersions (the default one
    // included), so they decide the runtime over the tab's saved runtimeId.
    const env = await boot(t, {
      session: {
        [STATE_KEY]: JSON.stringify({
          runtimeId: "php84-omeka411",
          path: "/admin/item",
        }),
        [`blueprint-source:${SCOPE}`]: "default",
      },
    });
    assert.equal(env.frameUrl().searchParams.get("runtime"), DEFAULT_RUNTIME);
    assert.equal(env.frameUrl().searchParams.get("path"), "/admin/item");
    assert.equal(env.frameUrl().searchParams.has("clean"), false);
    assert.equal(env.$("#info-omeka-version").value, "4.2.1");
    assert.equal(env.$("#info-php-version").value, "8.3");
  });

  it("skips a saved login page when autologin is on", async (t) => {
    const env = await boot(t, {
      session: { [STATE_KEY]: JSON.stringify({ path: "/login" }) },
    });
    assert.equal(env.frameUrl().searchParams.get("path"), "/admin");
  });

  it("boots clean when the blueprint source changed since the last boot", async (t) => {
    const env = await boot(t, {
      query: "&php=8.2&omeka=4.3.0-alpha&opcache=0",
      session: {
        [STATE_KEY]: JSON.stringify({
          runtimeId: "php84-omeka411",
          path: "/x",
        }),
        [`blueprint-source:${SCOPE}`]: "url:https://example.test/other.json",
      },
    });
    const url = env.frameUrl();
    assert.equal(url.searchParams.get("clean"), "1");
    assert.equal(url.searchParams.get("runtime"), "php82-omeka430alpha");
    assert.equal(url.searchParams.get("path"), "/admin");
    assert.equal(url.searchParams.get("opcache"), "0");
    assert.equal(env.$("#info-opcache").checked, false);
    assert.equal(
      env.window.sessionStorage.getItem(`blueprint-source:${SCOPE}`),
      "default",
    );
  });

  it("uses the blueprint's landing page and preferred versions", async (t) => {
    const encoded = await encodeBlueprintParam({
      landingPage: "/s/demo",
      preferredVersions: { php: "8.5", omeka: "4.1.1" },
    });
    const env = await boot(t, { query: `&blueprint=${encoded}` });
    assert.equal(env.frameUrl().searchParams.get("runtime"), "php85-omeka411");
    assert.equal(env.frameUrl().searchParams.get("path"), "/s/demo");
  });

  it("builds the default blueprint without a default URL and lands on /", async (t) => {
    const env = await boot(t, {
      config: {
        defaultBlueprintUrl: undefined,
        landingPath: undefined,
        defaults: { phpVersion: "8.4", omekaVersion: "4.1.1" },
      },
    });
    assert.equal(env.frameUrl().searchParams.get("runtime"), "php84-omeka411");
    assert.equal(env.frameUrl().searchParams.get("path"), "/");
    assert.equal(
      JSON.parse(env.$("#blueprint-textarea").value).meta.title,
      "Omeka S Playground Blueprint",
    );
  });
});

describe("shell messages from the runtime", () => {
  it("tracks progress, readiness and in-site navigation", async (t) => {
    const env = await boot(t);
    const channel = env.channel();

    channel.emit({ kind: "progress", title: "Boot", detail: "extracting" });
    assert.match(env.logText(), /Boot: extracting/u);
    assert.equal(env.$("#address-input").disabled, true);

    channel.emit({ kind: "ready", path: "/admin" });
    assert.equal(env.$("#address-input").disabled, false);
    assert.equal(env.$("#back-button").disabled, true);
    const state = JSON.parse(env.window.sessionStorage.getItem(STATE_KEY));
    assert.equal(state.path, "/admin");
    assert.equal(state.runtimeId, DEFAULT_RUNTIME);
    assert.ok(state.lastReadyAt);

    // A later "ready" is an in-site navigation and is recorded for Back.
    channel.emit({ kind: "ready", path: "/admin/item" });
    assert.equal(env.$("#address-input").value, "/admin/item");
    assert.equal(env.$("#back-button").disabled, false);

    channel.emit({ kind: "navigate", path: "/admin/item/1" });
    assert.equal(env.$("#address-input").value, "/admin/item/1");
    channel.emit({ kind: "navigate" });
    assert.equal(env.$("#address-input").value, "/");
    channel.emit({ kind: "ready" });
    assert.equal(env.$("#address-input").value, "/");

    // Back walks the recorded paths without re-recording them.
    env.$("#back-button").click();
    assert.deepEqual(env.remotePosts.at(-1), {
      message: { kind: "navigate-site", path: "/admin/item/1" },
      origin: APP_BASE.slice(0, -"/app/".length),
    });
    channel.emit({ kind: "ready", path: "/admin/item/1" });
    env.$("#back-button").click();
    assert.equal(env.remotePosts.at(-1).message.path, "/admin/item");
    env.$("#back-button").click();
    assert.equal(env.remotePosts.at(-1).message.path, "/admin");
    assert.equal(env.$("#back-button").disabled, true);
    const posts = env.remotePosts.length;
    env.$("#back-button").disabled = false;
    env.$("#back-button").click();
    assert.equal(env.remotePosts.length, posts);
  });

  it("logs runtime errors, reports them and asks for PHP diagnostics once", async (t) => {
    const env = await bootReady(t);
    const channel = env.channel();

    channel.emit({
      kind: "error",
      detail: "PHP fatal error",
      source: "request",
      path: "/admin/item",
    });
    assert.match(env.logText(), /PHP fatal error/u);
    assert.equal(env.$("#address-input").disabled, false);
    assert.deepEqual(env.remotePosts.at(-1).message, {
      kind: "capture-phpinfo",
    });
    assert.match(
      env.logText(),
      /Requesting PHP runtime diagnostics \(bootstrap-error\)/u,
    );
    await waitFor(() => env.reports.length === 1, "report");
    assert.equal(env.reports[0].level, "error");
    assert.deepEqual(env.reports[0].extra, {
      source: "request",
      path: "/admin/item",
    });

    // Not booted any more: navigation reloads the frame instead of posting.
    const before = env.frameUrl().searchParams.get("instance");
    env.$("#address-input").value = "/s/site";
    env
      .$("#address-form")
      .dispatchEvent(new env.happy.Event("submit", { cancelable: true }));
    await waitFor(
      () => env.frameUrl().searchParams.get("instance") !== before,
      "frame reload",
    );
    assert.equal(env.frameUrl().searchParams.get("path"), "/s/site");
    assert.equal(env.channels.at(-2).closed, true);

    // With diagnostics captured, a later error does not ask again.
    env.channel().emit({
      kind: "phpinfo",
      html: "<html><head></head><body>x</body></html>",
    });
    const posts = env.remotePosts.length;
    env.channel().emit({ kind: "error", detail: "again" });
    assert.equal(env.remotePosts.length, posts);
  });

  it("classifies a remote Service Worker failure as a warning", async (t) => {
    const env = await bootReady(t);
    env.channel().emit({
      kind: "error",
      detail: "no SW",
      errorName: SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
    });
    await waitFor(() => env.reports.length === 1, "report");
    assert.equal(env.reports[0].level, "warning");
    assert.equal(env.reports[0].extra.source, "service-worker-unsupported");
  });

  it("shows captured PHP info, trace and flush messages", async (t) => {
    const env = await bootReady(t);
    const channel = env.channel();
    const phpInfo = env.$("#phpinfo-frame");

    channel.emit({
      kind: "phpinfo",
      html: "<html><head></head><body>info</body></html>",
    });
    assert.match(
      phpInfo.srcdoc,
      /<style>[\s\S]*\.center table[\s\S]*<\/style><\/head><body>info/u,
    );
    assert.match(env.logText(), /Captured PHP runtime diagnostics\./u);
    channel.emit({ kind: "phpinfo", detail: "Empty capture" });
    assert.match(phpInfo.srcdoc, /No PHP diagnostics captured yet/u);
    assert.match(env.logText(), /Empty capture/u);

    channel.emit({ kind: "trace", detail: "[trace] step" });
    channel.emit({ kind: "trace" });
    channel.emit({ kind: "persistence-flushed" });
    channel.emit({ kind: "persistence-flushed", detail: "flushed 3 ops" });
    channel.emit({ kind: "unknown-kind", detail: "ignored" });
    assert.match(env.logText(), /\[trace\] step/u);
    assert.match(env.logText(), /Persistence journal flushed\./u);
    assert.match(env.logText(), /flushed 3 ops/u);
    assert.doesNotMatch(env.logText(), /ignored/u);
  });

  it("logs Service Worker debug messages only", async (t) => {
    const env = await boot(t);
    env.emitServiceWorkerMessage({ kind: "sw-debug", detail: "cache hit" });
    env.emitServiceWorkerMessage({ kind: "other", detail: "nope" });
    env.emitServiceWorkerMessage(null);
    assert.match(env.logText(), /\[sw\] cache hit/u);
    assert.doesNotMatch(env.logText(), /nope/u);
  });
});

describe("shell toolbar", () => {
  it("ignores navigation while locked", async (t) => {
    const env = await boot(t);
    const src = env.$("#site-frame").getAttribute("src");
    env.$("#home-button").disabled = false;
    env.$("#home-button").click();
    env
      .$("#address-form")
      .dispatchEvent(new env.happy.Event("submit", { cancelable: true }));
    env.$("#export-button").disabled = false;
    env.$("#export-button").click();
    env.$("#reset-button").disabled = false;
    env.$("#reset-button").click();
    await flush();
    assert.equal(env.$("#site-frame").getAttribute("src"), src);
    assert.equal(env.remotePosts.length, 0);
    assert.equal(env.downloads.length, 0);
  });

  it("navigates home, admin, the address and refreshes in place", async (t) => {
    const env = await bootReady(t);
    env.$("#home-button").click();
    assert.deepEqual(env.remotePosts.at(-1).message, {
      kind: "navigate-site",
      path: "/",
    });
    assert.match(env.logText(), /Navigating site to \//u);
    env.$("#admin-button").click();
    assert.deepEqual(env.remotePosts.at(-1).message, {
      kind: "navigate-site",
      path: "/admin",
    });
    env.$("#address-input").value = "";
    env
      .$("#address-form")
      .dispatchEvent(new env.happy.Event("submit", { cancelable: true }));
    assert.equal(env.remotePosts.at(-1).message.path, "/");
    env.$("#refresh-button").click();
    assert.equal(env.remotePosts.at(-1).message.path, "/");
    assert.equal(
      JSON.parse(env.window.sessionStorage.getItem(STATE_KEY)).path,
      "/",
    );
  });

  it("reloads the frame when the remote window is gone", async (t) => {
    const env = await bootReady(t);
    env.remoteAvailable = false;
    const before = env.frameUrl().searchParams.get("instance");
    env.$("#admin-button").click();
    await waitFor(
      () => env.frameUrl().searchParams.get("instance") !== before,
      "frame reload",
    );
    assert.equal(env.frameUrl().searchParams.get("path"), "/admin");
  });

  it("switches panels and toggles the side panel", async (t) => {
    const env = await bootReady(t);
    for (const [tab, panel] of [
      ["#logs-tab", "#logs-panel"],
      ["#blueprint-tab", "#blueprint-panel"],
      ["#info-tab", "#info-panel"],
    ]) {
      env.$(tab).click();
      assert.equal(hidden(env.$(panel)), false);
      assert.equal(env.$(tab).getAttribute("aria-selected"), "true");
      assert.ok(env.$(tab).classList.contains("is-active"));
      assert.equal(
        env.document.querySelectorAll(".panel-tab.is-active").length,
        1,
      );
    }

    env.$("#phpinfo-tab").click();
    assert.equal(hidden(env.$("#phpinfo-panel")), false);
    assert.deepEqual(env.remotePosts.at(-1), {
      message: { kind: "capture-phpinfo" },
      origin: "https://play.test",
    });
    assert.match(env.logText(), /\(tab-click\)/u);
    env.$("#info-tab").click();
    env.$("#refresh-phpinfo-button").click();
    assert.equal(hidden(env.$("#phpinfo-panel")), false);
    assert.match(env.logText(), /\(manual\)/u);

    env.remoteAvailable = false;
    env.$("#refresh-phpinfo-button").click();
    assert.match(env.logText(), /remote frame not available/u);

    const side = env.$("#side-panel");
    const workspace = env.$("#workspace");
    env.$("#panel-close-button").click();
    assert.ok(side.classList.contains("is-collapsed"));
    env.$("#panel-toggle-button").click();
    assert.equal(side.classList.contains("is-collapsed"), false);
    assert.equal(workspace.classList.contains("is-panel-collapsed"), false);
    assert.equal(
      env.$("#panel-toggle-button").getAttribute("aria-expanded"),
      "true",
    );
    env.$("#panel-close-button").click();
    assert.ok(side.classList.contains("is-collapsed"));
    assert.ok(workspace.classList.contains("is-panel-collapsed"));
    assert.equal(
      env.$("#panel-toggle-button").getAttribute("aria-expanded"),
      "false",
    );
  });

  it("refuses to capture PHP info before the config is loaded", async (t) => {
    const env = await boot(t, {
      fetchHandler: (url) =>
        url.endsWith("/playground.config.json") ? new Promise(() => {}) : null,
      wait: null,
    });
    env.$("#phpinfo-tab").click();
    assert.match(
      env.logText(),
      /Cannot capture PHP info before the playground configuration is loaded/u,
    );
  });

  it("copies and clears the logs", async (t) => {
    const env = await bootReady(t);
    const copy = env.$("#copy-logs-button");
    const icon = copy.innerHTML;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    copy.click();
    await flush();
    assert.match(env.clipboard.writes[0], /Runtime selection/u);
    assert.equal(copy.textContent, "✓");
    t.mock.timers.tick(1200);
    assert.equal(copy.innerHTML, icon);

    env.$("#clear-logs-button").click();
    assert.equal(env.logText(), "");
  });

  it("copies the runtime and build IDs", async (t) => {
    const env = await bootReady(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    env.$("#runtime-id-chip").click();
    assert.equal(env.clipboard.writes.at(-1), DEFAULT_RUNTIME);
    assert.equal(env.$("#runtime-id-value").textContent, "✓ copied");
    env.$("#build-id-chip").click();
    assert.equal(env.clipboard.writes.at(-1), BUILD_VERSION);
    assert.equal(env.$("#build-id-value").textContent, "✓ copied");
    t.mock.timers.tick(1400);
    assert.equal(env.$("#runtime-id-value").textContent, DEFAULT_RUNTIME);
    assert.equal(env.$("#build-id-value").textContent, BUILD_VERSION);
  });

  it("exports the normalized blueprint, or explains why not", async (t) => {
    const env = await bootReady(t);
    env.$("#export-button").click();
    assert.equal(env.downloads.length, 1);
    assert.equal(env.downloads[0].download, "omeka-playground.blueprint.json");
    assert.match(env.downloads[0].href, /^blob:/u);

    env.$("#blueprint-textarea").value = "{";
    env.$("#blueprint-textarea").dispatchEvent(new env.happy.Event("input"));
    env.$("#export-button").click();
    assert.equal(env.downloads.length, 1);
    assert.match(env.logText(), /Cannot export blueprint: Invalid JSON/u);
  });

  it("resets to the default blueprint with a clean boot", async (t) => {
    const env = await bootReady(t);
    env.channel().emit({ kind: "navigate", path: "/admin/item" });
    env.window.sessionStorage.setItem(`omeka-playground:${SCOPE}:extra`, "x");
    env.$("#blueprint-textarea").value = "{}";

    env.$("#reset-button").click();
    await waitFor(
      () => env.frameUrl().searchParams.get("clean") === "1",
      "clean boot",
    );
    assert.equal(env.frameUrl().searchParams.get("path"), "/admin");
    assert.equal(env.$("#address-input").value, "/admin");
    assert.equal(env.$("#back-button").disabled, true);
    assert.equal(
      env.window.sessionStorage.getItem(`omeka-playground:${SCOPE}:extra`),
      null,
    );
    assert.equal(
      env.window.sessionStorage.getItem(`omeka-playground:blueprint:${SCOPE}`),
      null,
    );
    assert.equal(
      env.$("#blueprint-textarea").value,
      JSON.stringify(
        exportBlueprintPayload(env.config, buildDefaultBlueprint(env.config)),
        null,
        2,
      ),
    );
    assert.equal(env.registrations.length, 2);
  });

  it("keeps a URL-supplied blueprint across a reset", async (t) => {
    const encoded = await encodeBlueprintParam({ landingPage: "/s/demo" });
    const env = await bootReady(t, { query: `&blueprint=${encoded}` });
    const text = env.$("#blueprint-textarea").value;
    env.$("#reset-button").click();
    await waitFor(
      () => env.frameUrl().searchParams.get("clean") === "1",
      "clean boot",
    );
    assert.equal(env.frameUrl().searchParams.get("path"), "/s/demo");
    assert.equal(env.$("#blueprint-textarea").value, text);
  });
});

describe("shell import", () => {
  function importFile(env, name, text) {
    const input = env.$("#import-input");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: text === null ? [] : [new File([text], name)],
    });
    change(env, input);
  }

  it("restores a snapshot into the running frame", async (t) => {
    const env = await bootReady(t);
    importFile(
      env,
      "snap.json",
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        runtimeId: "php84-omeka411",
        path: "/s/x",
      }),
    );
    await waitFor(
      () => /Imported configuration from snap\.json/u.test(env.logText()),
      "import",
    );
    assert.equal(env.frameUrl().searchParams.get("runtime"), "php84-omeka411");
    assert.equal(env.frameUrl().searchParams.get("path"), "/s/x");
    assert.equal(env.$("#address-input").value, "/s/x");
    assert.ok(
      JSON.parse(env.window.sessionStorage.getItem(STATE_KEY)).importedAt,
    );

    // A snapshot without runtime/path keeps the runtime and goes home.
    importFile(env, "bare.json", JSON.stringify({ version: SNAPSHOT_VERSION }));
    await waitFor(() => /from bare\.json/u.test(env.logText()), "import");
    assert.equal(env.frameUrl().searchParams.get("runtime"), "php84-omeka411");
    assert.equal(env.frameUrl().searchParams.get("path"), "/admin");
  });

  it("reloads with an imported blueprint (JSONC accepted)", async (t) => {
    const env = await bootReady(t, {
      query: "&blueprint-url=https://x.test/a.json",
      fetchHandler: (url) =>
        url === "https://x.test/a.json"
          ? Response.json({ landingPage: "/s/a" })
          : null,
    });
    assert.equal(env.frameUrl().searchParams.get("path"), "/s/a");
    importFile(
      env,
      "bp.jsonc",
      '{\n  // comment\n  "landingPage": "/s/demo"\n}',
    );
    await waitFor(() => env.location.assigned.length === 1, "reload");
    const target = new URL(env.location.assigned[0]);
    assert.ok(target.searchParams.get("blueprint"));
    assert.equal(target.searchParams.has("blueprint-url"), false);
    assert.equal(target.searchParams.get("scope"), SCOPE);
    assert.equal(env.$("#import-input").value, "");
  });

  it("logs an unreadable file and ignores an empty selection", async (t) => {
    const env = await bootReady(t);
    importFile(env, "bad.json", "{ nope");
    await waitFor(
      () => env.$("#log-panel").lastElementChild.classList.contains("error"),
      "error",
    );
    assert.doesNotMatch(env.logText(), /Imported configuration/u);
    assert.equal(env.$("#import-input").value, "");
    const lines = env.$("#log-panel").children.length;
    importFile(env, "none", null);
    await flush();
    assert.equal(env.$("#log-panel").children.length, lines);
  });
});

describe("shell runtime configuration", () => {
  it("marks a version change dirty and applies it with a reset", async (t) => {
    const env = await bootReady(t);
    const omeka = env.$("#info-omeka-version");
    const php = env.$("#info-php-version");
    omeka.value = "4.1.1";
    change(env, omeka);
    assert.equal(php.value, "8.3");
    assert.equal(env.$("#config-status").textContent, "Unsaved");
    assert.equal(env.$("#config-status").className, "dirty-note");
    assert.equal(hidden(env.$("#config-warning")), false);
    assert.ok(hidden(env.$("#config-reload-note")));
    assert.equal(hidden(env.$("#config-apply")), false);
    assert.equal(env.$("#config-apply").textContent, "Apply & Reset");
    assert.ok(env.$("#config-apply").classList.contains("danger"));

    // Reselecting the running version clears the dirty state.
    omeka.value = "4.2.1";
    change(env, omeka);
    assert.equal(env.$("#config-status").textContent, "Running");
    assert.ok(hidden(env.$("#config-apply")));
    env.$("#config-apply").click();
    await flush();
    assert.equal(env.location.assigned.length, 0);

    php.value = "8.4";
    change(env, php);
    omeka.value = "4.1.1";
    change(env, omeka);
    assert.equal(php.value, "8.4");
    env.$("#config-apply").click();
    await waitFor(() => env.location.assigned.length === 1, "reload");
    const target = new URL(env.location.assigned[0]);
    assert.equal(target.searchParams.get("php"), "8.4");
    assert.equal(target.searchParams.get("omeka"), "4.1.1");
    assert.equal(env.window.sessionStorage.getItem(STATE_KEY), null);
  });

  it("restarts only PHP for an OPcache toggle, flushing the journal first", async (t) => {
    const env = await bootReady(t);
    const opcache = env.$("#info-opcache");
    opcache.checked = false;
    change(env, opcache);
    assert.equal(hidden(env.$("#config-reload-note")), false);
    assert.ok(hidden(env.$("#config-warning")));
    assert.equal(env.$("#config-apply").textContent, "Apply & Reload");
    assert.equal(env.$("#config-apply").classList.contains("danger"), false);

    const before = env.frameUrl().searchParams.get("instance");
    env.$("#config-apply").click();
    await waitFor(
      () => env.remotePosts.at(-1)?.message.kind === "flush-persistence",
      "flush request",
    );
    assert.equal(
      new URL(env.history.replaced[0]).searchParams.get("opcache"),
      "0",
    );
    assert.match(env.logText(), /OPcache disabled; restarting PHP/u);
    assert.equal(env.frameUrl().searchParams.get("instance"), before);

    env.channel().emit({ kind: "persistence-flushed" });
    await waitFor(
      () => env.frameUrl().searchParams.get("instance") !== before,
      "PHP restart",
    );
    assert.equal(env.frameUrl().searchParams.get("opcache"), "0");
    assert.equal(env.frameUrl().searchParams.has("clean"), false);
    assert.equal(env.location.assigned.length, 0);
    assert.equal(env.$("#config-status").textContent, "Running");

    // Back to the config default: the URL parameter is dropped again.
    opcache.checked = true;
    change(env, opcache);
    env.$("#config-apply").click();
    await waitFor(() => env.history.replaced.length === 2, "url update");
    assert.equal(
      new URL(env.history.replaced[1]).searchParams.has("opcache"),
      false,
    );
    assert.match(env.logText(), /OPcache enabled; restarting PHP/u);
  });

  it("restarts anyway when the journal flush cannot be requested or times out", async (t) => {
    const env = await bootReady(t);
    const opcache = env.$("#info-opcache");

    env.remoteAvailable = false;
    opcache.checked = false;
    change(env, opcache);
    const before = env.frameUrl().searchParams.get("instance");
    env.$("#config-apply").click();
    await waitFor(
      () => env.frameUrl().searchParams.get("instance") !== before,
      "PHP restart",
    );

    env.remoteAvailable = true;
    env.channel().emit({ kind: "ready", path: "/admin" });
    opcache.checked = true;
    change(env, opcache);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    env.$("#config-apply").click();
    await flush();
    assert.equal(env.remotePosts.at(-1).message.kind, "flush-persistence");
    t.mock.timers.tick(60_000);
    t.mock.timers.reset();
    await waitFor(
      () => /did not finish in time; restarting anyway/u.test(env.logText()),
      "timeout",
    );
  });

  it("restarts without flushing when the runtime has not booted", async (t) => {
    const env = await boot(t);
    const opcache = env.$("#info-opcache");
    opcache.checked = false;
    change(env, opcache);
    const before = env.frameUrl().searchParams.get("instance");
    env.$("#config-apply").click();
    await waitFor(
      () => env.frameUrl().searchParams.get("instance") !== before,
      "PHP restart",
    );
    assert.equal(env.remotePosts.length, 0);
  });
});
