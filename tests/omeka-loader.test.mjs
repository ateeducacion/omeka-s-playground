import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { sanitizeArchivePath, streamZipEntries } from "../lib/omeka-loader.js";

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
