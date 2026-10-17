import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isOpcacheEnabled,
  OPCACHE_BLACKLIST,
  OPCACHE_BLACKLIST_PATH,
  OPCACHE_INI_ENTRIES,
  OPCACHE_SAPI_NAME,
  writeOpcacheBlacklist,
} from "../src/runtime/opcache.js";

describe("OPCACHE_INI_ENTRIES (ADR-0030)", () => {
  it("validates timestamps on every request", () => {
    assert.equal(OPCACHE_INI_ENTRIES["opcache.validate_timestamps"], "1");
    assert.equal(OPCACHE_INI_ENTRIES["opcache.revalidate_freq"], "0");
  });

  it("keeps the file cache and points the blacklist at the eval script", () => {
    assert.equal(OPCACHE_INI_ENTRIES["opcache.file_cache_only"], "1");
    assert.equal(
      OPCACHE_INI_ENTRIES["opcache.file_cache"],
      "/internal/shared/opcache",
    );
    assert.equal(
      OPCACHE_INI_ENTRIES["opcache.blacklist_filename"],
      OPCACHE_BLACKLIST_PATH,
    );
    assert.equal(OPCACHE_BLACKLIST, "/internal/eval.php\n");
  });

  it("does not override PHP's default file_update_protection", () => {
    assert.equal(
      OPCACHE_INI_ENTRIES["opcache.file_update_protection"],
      undefined,
    );
  });
});

describe("writeOpcacheBlacklist", () => {
  it("creates the parent directory and writes the blacklist", () => {
    const dirs = [];
    const files = new Map();
    writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      { mkdirTree: (path) => dirs.push(path) },
    );
    assert.deepEqual(dirs, ["/internal/shared"]);
    assert.equal(files.get(OPCACHE_BLACKLIST_PATH), OPCACHE_BLACKLIST);
  });

  it("tolerates an existing directory", () => {
    const files = new Map();
    writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      {
        mkdirTree: () => {
          throw new Error("EEXIST");
        },
      },
    );
    assert.equal(files.size, 1);
  });
});

describe("isOpcacheEnabled (ADR-0031)", () => {
  it("is off by default", () => {
    assert.equal(isOpcacheEnabled(null, {}), false);
    assert.equal(isOpcacheEnabled(undefined, { opcache: false }), false);
    assert.equal(isOpcacheEnabled("", { opcache: false }), false);
  });

  it("follows the config when the URL has no opinion", () => {
    assert.equal(isOpcacheEnabled(null, { opcache: true }), true);
    assert.equal(isOpcacheEnabled(null, { opcache: "true" }), false);
  });

  it("lets the URL parameter override the config either way", () => {
    assert.equal(isOpcacheEnabled("1", { opcache: false }), true);
    assert.equal(isOpcacheEnabled("yes", {}), true);
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      assert.equal(isOpcacheEnabled(off, { opcache: true }), false, off);
    }
  });

  it("uses a whitelisted SAPI name that is neither cgi nor cli", () => {
    assert.equal(OPCACHE_SAPI_NAME, "uwsgi");
  });
});
