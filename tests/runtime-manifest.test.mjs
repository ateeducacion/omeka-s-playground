import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildManifestUrl, fetchManifest } from "../src/runtime/manifest.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchManifest boot fetches", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("names the 'manifest' phase when the versioned fetch fails at the network layer", async () => {
    // What WebKit and Firefox actually throw: a bare message, no URL, no phase.
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };

    await assert.rejects(fetchManifest({ omekaVersion: "4.1.1" }), (error) => {
      assert.match(error.message, /Network error while fetching manifest \(/u);
      assert.ok(!error.message.includes("manifest fallback"));
      assert.match(error.message, /assets\/manifests\//u);
      assert.match(error.message, /Load failed/u);
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
  });

  it("names the 'manifest fallback' phase when the fallback fetch fails", async () => {
    // A KNOWN version, so the versioned URL is 4.1.1.json and the fallback is
    // a distinct request: an unknown version already resolves to latest.json.
    globalThis.fetch = async (url) => {
      if (!String(url).endsWith("latest.json")) {
        // The versioned manifest 404s, which is what triggers the fallback.
        return jsonResponse({ error: "missing" }, 404);
      }
      throw new TypeError("NetworkError when attempting to fetch resource.");
    };

    await assert.rejects(fetchManifest({ omekaVersion: "4.1.1" }), (error) => {
      assert.match(
        error.message,
        /Network error while fetching manifest fallback \(/u,
      );
      assert.match(error.message, /assets\/manifests\/latest\.json/u);
      assert.match(error.message, /NetworkError/u);
      return true;
    });
  });

  it("strips the query string from the reported URL", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };

    await assert.rejects(fetchManifest({ omekaVersion: "4.1.1" }), (error) => {
      // Cache-busting params would fragment Sentry grouping.
      assert.ok(!error.message.includes("?"));
      return true;
    });
  });

  it("still resolves the versioned manifest when the network is healthy", async () => {
    globalThis.fetch = async () => jsonResponse({ release: "4.1.1" });

    const manifest = await fetchManifest({ omekaVersion: "4.1.1" });
    assert.equal(manifest.release, "4.1.1");
    assert.equal(
      manifest._manifestUrl,
      buildManifestUrl("4.1.1").toString(),
      "the versioned URL is still recorded on the manifest",
    );
  });

  it("still falls back to latest.json on a 404", async () => {
    globalThis.fetch = async (url) =>
      String(url).endsWith("latest.json")
        ? jsonResponse({ release: "legacy" })
        : jsonResponse({ error: "missing" }, 404);

    const manifest = await fetchManifest({ omekaVersion: "4.1.1" });
    assert.equal(manifest.release, "legacy");
    assert.match(manifest._manifestUrl, /assets\/manifests\/latest\.json$/u);
  });

  it("still surfaces a non-404 HTTP status without the network wrapper", async () => {
    globalThis.fetch = async () => jsonResponse({ error: "boom" }, 500);

    await assert.rejects(fetchManifest({ omekaVersion: "4.1.1" }), (error) => {
      assert.equal(error.message, "Unable to load Omeka manifest: 500");
      return true;
    });
  });
});
