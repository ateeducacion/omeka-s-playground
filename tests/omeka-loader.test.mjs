import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  fetchBootAsset,
  sanitizeArchivePath,
  streamZipEntries,
} from "../lib/omeka-loader.js";

function buildSampleZip() {
  // A nested file, a directory entry, and a crafted ZIP-slip entry.
  return zipSync({
    "index.php": strToU8("<?php // root\n"),
    "application/Module.php": strToU8("<?php // nested\n"),
    "data/": new Uint8Array(0),
    "../evil.php": strToU8("<?php // pwned\n"),
  });
}

describe("sanitizeArchivePath", () => {
  it("rejects ZIP-slip entries containing '..'", () => {
    assert.equal(sanitizeArchivePath("../evil.php"), null);
    assert.equal(sanitizeArchivePath("a/../../evil"), null);
  });

  it("strips leading slashes and '.' segments, normalizes backslashes", () => {
    assert.equal(sanitizeArchivePath("/index.php"), "index.php");
    assert.equal(
      sanitizeArchivePath("./application/Module.php"),
      "application/Module.php",
    );
    assert.equal(
      sanitizeArchivePath("application\\config\\module.config.php"),
      "application/config/module.config.php",
    );
  });

  it("returns null for empty / root-only paths", () => {
    assert.equal(sanitizeArchivePath(""), null);
    assert.equal(sanitizeArchivePath("/"), null);
  });
});

describe("streamZipEntries", () => {
  it("yields each archive entry one at a time (used for add-on ZIPs)", async () => {
    const names = [];
    for await (const entry of streamZipEntries(buildSampleZip())) {
      names.push(entry.name);
    }
    assert.ok(names.includes("index.php"));
    assert.ok(names.includes("application/Module.php"));
    assert.ok(names.includes("../evil.php"));
  });
});

describe("fetchBootAsset", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("names the boot phase and the query-less URL on a network failure", async () => {
    // What WebKit and Firefox actually throw: a bare message, no URL, no phase.
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };

    await assert.rejects(
      fetchBootAsset(
        "https://example.test/assets/manifests/4.1.1.json?v=abc123",
        { cache: "no-cache" },
        "manifest",
      ),
      (error) => {
        assert.match(error.message, /manifest/u);
        assert.match(
          error.message,
          /https:\/\/example\.test\/assets\/manifests\/4\.1\.1\.json/u,
        );
        // The cache-busting param would fragment Sentry grouping.
        assert.ok(!error.message.includes("v=abc123"));
        assert.match(error.message, /Load failed/u);
        assert.ok(error.cause instanceof TypeError);
        return true;
      },
    );
  });

  it("passes the response through untouched when the fetch resolves", async () => {
    const expected = new Response("ok", { status: 200 });
    globalThis.fetch = async () => expected;

    const response = await fetchBootAsset(
      "https://example.test/x",
      undefined,
      "asset",
    );
    assert.equal(response, expected);
  });
});
