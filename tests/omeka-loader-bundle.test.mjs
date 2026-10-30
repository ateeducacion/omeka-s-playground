import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  fetchBundleWithCache,
  fetchManifest,
  fetchWithProgress,
  resolveBootstrapArchive,
  streamZipEntries,
} from "../lib/omeka-loader.js";
import { stubFetch } from "./helpers/fake-php.mjs";

const BUNDLE = new TextEncoder().encode("core-bundle-bytes");
const SHA = createHash("sha256").update(BUNDLE).digest("hex");
const MANIFEST_URL = "https://app.test/assets/manifests/omeka.json";
const BUNDLE_URL = "https://app.test/assets/omeka/core.tar.zst";

const manifest = (bundle = { path: "../omeka/core.tar.zst", sha256: SHA }) => ({
  bundle,
  _manifestUrl: MANIFEST_URL,
});

// A Cache API stand-in keyed by URL.
function stubCaches(t, { failOpen = false, failPut = false } = {}) {
  const store = new Map();
  const original = globalThis.caches;
  globalThis.caches = {
    async open(name) {
      assert.equal(name, "omeka-playground-bundles");
      if (failOpen) throw new Error("SecurityError");
      return {
        match: async (url) => store.get(url)?.clone(),
        put: async (url, response) => {
          if (failPut) throw new Error("QuotaExceeded");
          store.set(url, response);
        },
        delete: async (url) => store.delete(url),
      };
    },
  };
  t.after(() => {
    globalThis.caches = original;
  });
  return store;
}

describe("fetchWithProgress", () => {
  it("streams a sized body and reports monotonically rising progress", async (t) => {
    stubFetch(
      t,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.enqueue(new Uint8Array([3, 4]));
              controller.close();
            },
          }),
          { headers: { "content-length": "4" } },
        ),
    );
    const progress = [];
    const bytes = await fetchWithProgress("https://x.test/a", (p) =>
      progress.push(p.ratio),
    );
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.deepEqual(progress, [0.5, 1]);
  });

  it("reads unsized bodies at once and reports completion", async (t) => {
    stubFetch(t, async () => new Response("abc"));
    const progress = [];
    const bytes = await fetchWithProgress("https://x.test/a", (p) =>
      progress.push(p),
    );
    assert.equal(new TextDecoder().decode(bytes), "abc");
    assert.deepEqual(progress, [{ loaded: 3, total: 3, ratio: 1 }]);
  });

  it("throws on a non-OK status", async (t) => {
    stubFetch(t, async () => new Response("", { status: 503 }));
    await assert.rejects(
      fetchWithProgress("https://x.test/a"),
      /Failed to fetch https:\/\/x.test\/a: 503/,
    );
  });
});

describe("fetchManifest", () => {
  it("loads the manifest and records its URL", async (t) => {
    const calls = stubFetch(t, async () => Response.json({ release: "4.2.1" }));
    const result = await fetchManifest(MANIFEST_URL);
    assert.deepEqual(result, { release: "4.2.1", _manifestUrl: MANIFEST_URL });
    assert.deepEqual(calls[0].init, { cache: "no-cache" });
  });

  it("defaults to the default-version manifest and rejects non-OK", async (t) => {
    const calls = stubFetch(t, async () => new Response("", { status: 404 }));
    await assert.rejects(fetchManifest(), /Unable to load manifest: 404/);
    assert.match(calls[0].url, /assets\/manifests\/.+\.json$/);
  });
});

describe("fetchBundleWithCache", () => {
  it("downloads, verifies and caches the bundle, then serves it from cache", async (t) => {
    const store = stubCaches(t);
    const calls = stubFetch(t, async () => new Response(BUNDLE));
    assert.deepEqual(await fetchBundleWithCache(manifest()), BUNDLE);
    assert.equal(calls[0].url, BUNDLE_URL);
    assert.ok(store.has(BUNDLE_URL));

    const progress = [];
    const cached = await fetchBundleWithCache(manifest(), (p) =>
      progress.push(p),
    );
    assert.deepEqual(cached, BUNDLE);
    assert.equal(calls.length, 1);
    assert.equal(progress[0].ratio, 1);
  });

  it("discards a cached bundle whose hash no longer matches", async (t) => {
    const store = stubCaches(t);
    store.set(BUNDLE_URL, new Response("stale"));
    const calls = stubFetch(t, async () => new Response(BUNDLE));
    assert.deepEqual(await fetchBundleWithCache(manifest()), BUNDLE);
    assert.equal(calls.length, 1);
    assert.equal(
      await store.get(BUNDLE_URL).clone().text(),
      "core-bundle-bytes",
    );
  });

  it("trusts a cached bundle when the manifest has no hash", async (t) => {
    const store = stubCaches(t);
    store.set(BUNDLE_URL, new Response("unhashed"));
    const calls = stubFetch(t, async () => assert.fail("must use cache"));
    const progress = [];
    const bytes = await fetchBundleWithCache(
      manifest({ path: "../omeka/core.tar.zst" }),
      (p) => progress.push(p),
    );
    assert.equal(new TextDecoder().decode(bytes), "unhashed");
    assert.equal(calls.length, 0);
    assert.equal(progress.length, 1);
  });

  it("rejects a downloaded bundle with the wrong hash", async (t) => {
    stubCaches(t, { failOpen: true });
    stubFetch(t, async () => new Response("tampered"));
    await assert.rejects(
      fetchBundleWithCache(manifest()),
      /Bundle SHA-256 mismatch: expected [0-9a-f]{64}, got [0-9a-f]{64}/,
    );
  });

  it("refetches past the HTTP cache when the downloaded bytes mismatch", async (t) => {
    const store = stubCaches(t);
    // A deploy rebuilt the bundle at the same URL: the HTTP cache still holds
    // the previous build while the manifest already advertises the new sha256.
    const calls = stubFetch(t, async (_url, init) =>
      init?.cache === "reload" ? new Response(BUNDLE) : new Response("stale"),
    );
    assert.deepEqual(await fetchBundleWithCache(manifest()), BUNDLE);
    assert.equal(calls.length, 2, "one retry");
    assert.equal(
      calls[1].init?.cache,
      "reload",
      "retry bypasses the HTTP cache",
    );
    assert.equal(
      await store.get(BUNDLE_URL).clone().text(),
      "core-bundle-bytes",
    );
  });

  it("works without the Cache API and ignores cache write failures", async (t) => {
    stubCaches(t, { failPut: true });
    stubFetch(t, async () => new Response(BUNDLE));
    assert.deepEqual(await fetchBundleWithCache(manifest()), BUNDLE);
  });

  it("requires a bundle path", async () => {
    await assert.rejects(
      fetchBundleWithCache({ _manifestUrl: MANIFEST_URL }),
      /does not describe a bundle/,
    );
  });
});

describe("resolveBootstrapArchive", () => {
  it("reuses a given manifest or fetches one first", async (t) => {
    stubCaches(t, { failOpen: true });
    const calls = stubFetch(t, async (url) =>
      url === MANIFEST_URL
        ? Response.json({ bundle: { path: "../omeka/core.tar.zst" } })
        : new Response(BUNDLE),
    );
    const given = manifest();
    assert.equal(
      (await resolveBootstrapArchive({ manifest: given })).manifest,
      given,
    );
    assert.equal(calls.length, 1);

    const fetched = await resolveBootstrapArchive({
      manifestUrl: MANIFEST_URL,
    });
    assert.equal(fetched.manifest._manifestUrl, MANIFEST_URL);
    assert.deepEqual(fetched.bytes, BUNDLE);
  });
});

describe("streamZipEntries without DecompressionStream", () => {
  it("falls back to fflate and flags directories", async (t) => {
    const original = globalThis.DecompressionStream;
    globalThis.DecompressionStream = undefined;
    t.after(() => {
      globalThis.DecompressionStream = original;
    });
    const zip = zipSync({
      "dir/": new Uint8Array(0),
      "dir/a.txt": strToU8("A"),
    });
    const entries = [];
    for await (const entry of streamZipEntries(zip)) entries.push(entry);
    assert.deepEqual(
      entries.map((e) => [
        e.name,
        e.isDirectory,
        e.data && new TextDecoder().decode(e.data),
      ]),
      [
        ["dir/", true, null],
        ["dir/a.txt", false, "A"],
      ],
    );
  });
});
