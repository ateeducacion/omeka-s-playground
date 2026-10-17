import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPCACHE_BLACKLIST,
  OPCACHE_BLACKLIST_PATH,
  OPCACHE_INI_ENTRIES,
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
