import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar, normalizeEntries } from "../scripts/lib/tar-ustar.mjs";
import { wrapPhpInstance } from "../src/runtime/php-compat.js";
import { fetchArrayBuffer, mountReadonlyCore } from "../src/runtime/vfs.js";
import { createFakeRawPhp, stubFetch } from "./helpers/fake-php.mjs";

const enc = (s) => new TextEncoder().encode(s);

function gzippedCore(files) {
  return new Uint8Array(gzipSync(createUstarTar(normalizeEntries(files))));
}

const CORE = {
  "index.php": enc("<?php echo 'front';"),
  "application/Module.php": enc("<?php // module"),
};

describe("mountReadonlyCore", () => {
  it("streams prefetched gzip bytes into the target root", async () => {
    const raw = createFakeRawPhp();
    const php = wrapPhpInstance(raw);
    const published = [];
    const result = await mountReadonlyCore(
      php,
      { bundle: { codec: "gzip", fileCount: 2 } },
      {
        root: "/www/omeka",
        bytes: gzippedCore(CORE),
        publish: (msg, p) => published.push([msg, p]),
      },
    );
    assert.equal(result.entries, 2);
    assert.equal(
      raw.readFileAsText("/www/omeka/application/Module.php"),
      "<?php // module",
    );
    assert.deepEqual(published, [["Extracting Omeka core…", 0.45]]);
  });

  it("fails loud when the streamed file count does not match the manifest", async () => {
    const php = wrapPhpInstance(createFakeRawPhp());
    await assert.rejects(
      mountReadonlyCore(
        php,
        { bundle: { codec: "gzip", fileCount: 5 } },
        { bytes: gzippedCore(CORE) },
      ),
      /parity mismatch: 2 != 5/,
    );
  });

  it("downloads the bundle lazily and reports download progress", async (t) => {
    const bytes = gzippedCore(CORE);
    const calls = stubFetch(t, () => new Response(bytes));
    const raw = createFakeRawPhp();
    const published = [];
    await mountReadonlyCore(
      wrapPhpInstance(raw),
      {
        _manifestUrl: "https://app.test/assets/manifests/m.json",
        bundle: { codec: "gzip", path: "../omeka/core.tar.gz" },
      },
      { publish: (msg, p) => published.push([msg, p]) },
    );
    assert.equal(calls[0].url, "https://app.test/assets/omeka/core.tar.gz");
    assert.equal(published[0][0], "Downloading Omeka bundle: 100%");
    assert.ok(Math.abs(published[0][1] - 0.45) < 1e-9);
    assert.ok(raw.fileExists("/www/omeka/index.php"));
  });

  it("downloads lazily without a publish callback", async (t) => {
    stubFetch(t, () => new Response(gzippedCore(CORE)));
    const raw = createFakeRawPhp();
    const result = await mountReadonlyCore(wrapPhpInstance(raw), {
      _manifestUrl: "https://app.test/m.json",
      bundle: { codec: "gzip", path: "core.tar.gz" },
    });
    assert.equal(result.entries, 2);
  });
});

describe("fetchArrayBuffer", () => {
  it("returns the body and forwards the cache mode", async (t) => {
    const calls = stubFetch(t, () => new Response("abc"));
    const buffer = await fetchArrayBuffer("https://app.test/x", "no-store");
    assert.equal(new TextDecoder().decode(buffer), "abc");
    assert.deepEqual(calls[0].init, { cache: "no-store" });
  });

  it("throws with the status on a failed response", async (t) => {
    stubFetch(t, () => new Response("", { status: 404 }));
    await assert.rejects(
      fetchArrayBuffer("https://app.test/x"),
      /Unable to fetch https:\/\/app.test\/x: 404/,
    );
  });
});
