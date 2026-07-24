import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HOST_STATIC_PREFIXES,
  isHostStaticPath,
  rewriteHtmlAttributeUrl,
  rewriteHtmlDocument,
} from "../src/shared/html-url-rewrite.js";

const ORIGIN = "https://ateeducacion.github.io";
const APP_BASE = "/omeka-s-playground";
const SCOPE = {
  origin: ORIGIN,
  scopeId: "scope-1",
  runtimeId: "php83-omeka421",
  appBasePath: APP_BASE,
};

const SCOPED = "/omeka-s-playground/playground/scope-1/php83-omeka421";

describe("isHostStaticPath", () => {
  it("treats playground shell assets as host-static", () => {
    assert.equal(isHostStaticPath("/assets/samples/foo.png"), true);
    assert.equal(isHostStaticPath("/dist/php-worker.bundle.js"), true);
    assert.equal(isHostStaticPath("/src/shell/main.js"), true);
    assert.equal(isHostStaticPath("/favicon.ico"), true);
  });

  it("does NOT treat Omeka application assets as host-static (PR #120 regression)", () => {
    // This was the production bug: listing /application/asset/ as host-static
    // made the service worker fetch CSS/JS from GitHub Pages (404) instead of
    // routing them to the PHP/WASM worker that serves them from MEMFS.
    assert.equal(isHostStaticPath("/application/asset/css/style.css"), false);
    assert.equal(
      isHostStaticPath("/application/asset/vendor/jquery/jquery.min.js"),
      false,
    );
    assert.ok(
      !HOST_STATIC_PREFIXES.includes("/application/asset/"),
      "HOST_STATIC_PREFIXES must not include /application/asset/",
    );
  });
});

describe("rewriteHtmlAttributeUrl — GitHub Pages base path", () => {
  it("scopes bare Omeka asset paths into the playground runtime", () => {
    assert.equal(
      rewriteHtmlAttributeUrl("/application/asset/css/style.css", SCOPE),
      `${SCOPED}/application/asset/css/style.css`,
    );
  });

  it("scopes Omeka AssetUrl paths that already include the app base path", () => {
    // Omeka's AssetUrl uses Laminas basePath(), so on GH Pages it emits
    // `/omeka-s-playground/application/asset/...`. The previous rewrite left
    // those unscoped, and with /application/asset/ in STATIC_PREFIXES the SW
    // then 404'd them from the real host.
    assert.equal(
      rewriteHtmlAttributeUrl(
        "/omeka-s-playground/application/asset/css/style.css?v=4.2.1",
        SCOPE,
      ),
      `${SCOPED}/application/asset/css/style.css?v=4.2.1`,
    );
    assert.equal(
      rewriteHtmlAttributeUrl(
        "/omeka-s-playground/application/asset/vendor/tablesaw/tablesaw.stackonly.css",
        SCOPE,
      ),
      `${SCOPED}/application/asset/vendor/tablesaw/tablesaw.stackonly.css`,
    );
  });

  it("scopes admin and other Omeka app routes that include the app base", () => {
    assert.equal(
      rewriteHtmlAttributeUrl("/omeka-s-playground/admin", SCOPE),
      `${SCOPED}/admin`,
    );
    assert.equal(
      rewriteHtmlAttributeUrl("/omeka-s-playground/admin/item", SCOPE),
      `${SCOPED}/admin/item`,
    );
  });

  it("leaves already-scoped runtime paths alone", () => {
    const already = `${SCOPED}/application/asset/css/style.css`;
    assert.equal(rewriteHtmlAttributeUrl(already, SCOPE), already);
  });

  it("leaves shell/static sample assets unscoped", () => {
    assert.equal(
      rewriteHtmlAttributeUrl(
        "/omeka-s-playground/assets/samples/garden-of-earthly-delights.png",
        SCOPE,
      ),
      "/omeka-s-playground/assets/samples/garden-of-earthly-delights.png",
    );
    assert.equal(
      rewriteHtmlAttributeUrl("/omeka-s-playground/dist/php_8_3.wasm", SCOPE),
      "/omeka-s-playground/dist/php_8_3.wasm",
    );
  });

  it("leaves relative and special-scheme URLs alone", () => {
    assert.equal(
      rewriteHtmlAttributeUrl("css/style.css", SCOPE),
      "css/style.css",
    );
    assert.equal(rewriteHtmlAttributeUrl("#main", SCOPE), "#main");
    assert.equal(
      rewriteHtmlAttributeUrl("javascript:void(0)", SCOPE),
      "javascript:void(0)",
    );
    assert.equal(
      rewriteHtmlAttributeUrl("mailto:admin@example.com", SCOPE),
      "mailto:admin@example.com",
    );
  });

  it("works at site root without an app base path", () => {
    const local = {
      origin: "http://127.0.0.1:8080",
      scopeId: "scope-1",
      runtimeId: "php83-omeka421",
      appBasePath: "/",
    };
    assert.equal(
      rewriteHtmlAttributeUrl("/application/asset/css/style.css", local),
      "/playground/scope-1/php83-omeka421/application/asset/css/style.css",
    );
  });
});

describe("rewriteHtmlDocument", () => {
  it("rewrites href/src attributes for Omeka assets under the app base", () => {
    const html = [
      '<link rel="stylesheet" href="/omeka-s-playground/application/asset/css/style.css">',
      '<script src="/omeka-s-playground/application/asset/js/admin.js"></script>',
      '<a href="/omeka-s-playground/admin/item">Items</a>',
      '<img src="/omeka-s-playground/assets/samples/foo.png" alt="">',
    ].join("\n");

    const out = rewriteHtmlDocument(html, SCOPE);

    assert.match(
      out,
      new RegExp(
        `href="${SCOPED}/application/asset/css/style\\.css"`.replaceAll(
          "/",
          "\\/",
        ),
      ),
    );
    assert.match(
      out,
      new RegExp(
        `src="${SCOPED}/application/asset/js/admin\\.js"`.replaceAll(
          "/",
          "\\/",
        ),
      ),
    );
    assert.match(
      out,
      new RegExp(`href="${SCOPED}/admin/item"`.replaceAll("/", "\\/")),
    );
    // Shell sample stays on the static host.
    assert.match(out, /src="\/omeka-s-playground\/assets\/samples\/foo\.png"/);
  });

  it("handles HTML-escaped asset paths from Omeka", () => {
    const html =
      '<link href="&#x2F;omeka-s-playground&#x2F;application&#x2F;asset&#x2F;css&#x2F;style.css">';
    const out = rewriteHtmlDocument(html, SCOPE);
    assert.match(
      out,
      new RegExp(
        `href="${SCOPED}/application/asset/css/style\\.css"`.replaceAll(
          "/",
          "\\/",
        ),
      ),
    );
  });
});
