import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScopedSitePath,
  getBasePath,
  getBasePathFromPathname,
  hasBlueprintUrlOverride,
  joinBasePath,
  resolveAppUrl,
  resolveConfiguredProxyUrl,
  resolveProjectUrl,
} from "../src/shared/paths.js";

function withWindow(t, href) {
  const previousWindow = globalThis.window;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  globalThis.window = { location: new URL(href) };
  Object.defineProperty(globalThis, "location", {
    value: new URL(href),
    configurable: true,
  });
  t.after(() => {
    globalThis.window = previousWindow;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  });
}

describe("resolveProjectUrl", () => {
  it("uses the bundler-injected app root when present", (t) => {
    globalThis.__APP_ROOT__ = "https://cdn.test/app/";
    t.after(() => {
      delete globalThis.__APP_ROOT__;
    });
    assert.equal(
      resolveProjectUrl("assets/x.json").href,
      "https://cdn.test/app/assets/x.json",
    );
  });

  it("falls back to the repository root", () => {
    assert.match(
      resolveProjectUrl("package.json").href,
      /^file:.*\/package\.json$/,
    );
  });
});

describe("base paths", () => {
  it("derives the directory of a page pathname", () => {
    assert.equal(getBasePathFromPathname(), "/");
    assert.equal(getBasePathFromPathname(""), "/");
    assert.equal(getBasePathFromPathname("/index.html"), "/");
    assert.equal(
      getBasePathFromPathname("/omeka-s-playground/index.html"),
      "/omeka-s-playground/",
    );
  });

  it("joins without duplicate slashes", () => {
    assert.equal(joinBasePath("/app/", "/x//y"), "/app/x/y");
    assert.equal(joinBasePath("/app", "x"), "/app/x");
  });

  it("builds scoped site paths under the deployed subpath", (t) => {
    withWindow(t, "https://host.test/omeka-s-playground/index.html");
    assert.equal(getBasePath(), "/omeka-s-playground/");
    assert.equal(
      buildScopedSitePath("s1", "rt", "admin"),
      "/omeka-s-playground/playground/s1/rt/admin",
    );
    assert.equal(
      buildScopedSitePath("s1", "rt"),
      "/omeka-s-playground/playground/s1/rt/",
    );
  });
});

describe("hasBlueprintUrlOverride", () => {
  it("accepts URL objects and defaults to the window location", (t) => {
    withWindow(t, "https://host.test/app/?blueprint-url=x.json");
    assert.equal(hasBlueprintUrlOverride(), true);
    assert.equal(
      hasBlueprintUrlOverride(new URL("https://h.test/?x=1")),
      false,
    );
    assert.equal(hasBlueprintUrlOverride(""), true);
  });
});

describe("resolveAppUrl", () => {
  const page = new URL("https://host.test/omeka-s-playground/index.html");

  it("returns the current location for an empty path", (t) => {
    withWindow(t, "https://host.test/app/index.html");
    assert.equal(resolveAppUrl("").href, "https://host.test/app/index.html");
    assert.equal(resolveAppUrl("  ", page), page);
  });

  it("keeps absolute URLs and resolves app-relative paths under the base", () => {
    assert.equal(
      resolveAppUrl("https://proxy.test/?url=", page).href,
      "https://proxy.test/?url=",
    );
    assert.equal(
      resolveAppUrl("/__addon_proxy__", page).href,
      "https://host.test/omeka-s-playground/__addon_proxy__",
    );
    assert.equal(
      resolveAppUrl("x", "https://other.test/a/b.html").href,
      "https://other.test/a/x",
    );
  });

  it("falls back to localhost without a location", () => {
    assert.equal(resolveAppUrl("x").href, "http://localhost/x");
  });
});

describe("resolveConfiguredProxyUrl", () => {
  const prod = new URL("https://user.github.io/omeka-s-playground/index.html");
  const dev = new URL("http://localhost:8080/");

  it("prefers the local proxy path on dev hosts", () => {
    for (const host of [
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://[::1]/",
    ]) {
      assert.equal(
        resolveConfiguredProxyUrl(
          {
            addonProxyPath: "/__addon_proxy__",
            addonProxyUrl: "https://p.test/",
          },
          host,
        ).pathname,
        "/__addon_proxy__",
      );
    }
  });

  it("uses the proxy URL in production, else the path, else null", () => {
    assert.equal(
      resolveConfiguredProxyUrl(
        { proxyPath: "/__addon_proxy__", proxyUrl: "https://p.test/" },
        prod,
      ).href,
      "https://p.test/",
    );
    assert.equal(
      resolveConfiguredProxyUrl({ proxyPath: "/__addon_proxy__" }, prod).href,
      "https://user.github.io/omeka-s-playground/__addon_proxy__",
    );
    assert.equal(resolveConfiguredProxyUrl({}, dev), null);
    assert.equal(resolveConfiguredProxyUrl(), null);
  });

  it("defaults to the global location", (t) => {
    withWindow(t, "https://host.test/app/index.html");
    assert.equal(
      resolveConfiguredProxyUrl({ addonProxyPath: "/p" }).href,
      "https://host.test/app/p",
    );
  });
});
