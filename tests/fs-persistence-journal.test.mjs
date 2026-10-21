import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";

import {
  clearJournal,
  flushPendingOps,
  initFsPersistence,
  operationTouchesPathPrefix,
} from "../src/runtime/fs-persistence.js";

// Minimal in-memory IndexedDB: one autoIncrement object store per database,
// with request/transaction callbacks fired asynchronously as in browsers.
function createFakeIndexedDb() {
  const databases = new Map();
  const later = (fn) => setImmediate(fn);
  return {
    databases,
    failOpen: false,
    open(name) {
      const request = {};
      later(() => {
        if (this.failOpen) {
          request.error = new Error("open blocked");
          request.onerror?.();
          return;
        }
        let stores = databases.get(name);
        const db = {
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store) => stores.set(store, []),
          close() {},
          transaction(store) {
            const tx = {
              objectStore: () => ({
                getAll() {
                  const req = {};
                  later(() => {
                    req.result = [...stores.get(store)];
                    req.onsuccess?.();
                  });
                  return req;
                },
                clear: () => stores.set(store, []),
                add: (value) => stores.get(store).push(structuredClone(value)),
              }),
            };
            later(() => tx.oncomplete?.());
            return tx;
          },
        };
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
          request.result = db;
          request.onupgradeneeded?.({ target: { result: db } });
        }
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    },
  };
}

// A raw @php-wasm PHP stand-in exposing the FS hooks fs-journal wraps, plus
// the file API replay and hydration use.
function createRawPhp() {
  const files = new Map();
  const replayed = [];
  const FS = {
    write() {},
    truncate() {},
    unlink() {},
    mknod() {},
    mkdir() {},
    rmdir() {},
    rename() {},
    isFile: () => true,
    stat: (path) => ({ size: files.get(path)?.byteLength ?? 0 }),
  };
  return {
    files,
    replayed,
    FS,
    [__private__dont__use]: { FS },
    addEventListener() {},
    removeEventListener() {},
    readFileAsBuffer: (path) => files.get(path),
    writeFile(path, data) {
      replayed.push(["write", path]);
      files.set(path, data);
    },
    unlink(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      replayed.push(["unlink", path]);
      files.delete(path);
    },
    mkdir(path) {
      replayed.push(["mkdir", path]);
    },
  };
}

describe("initFsPersistence", () => {
  let fakeIdb;
  before(() => {
    fakeIdb = createFakeIndexedDb();
    globalThis.indexedDB = fakeIdb;
  });
  after(() => {
    delete globalThis.indexedDB;
  });

  it("journals /persist writes (not SQLite temp files) and replays them on the next boot", async () => {
    const first = createRawPhp();
    const persistence = await initFsPersistence(first, "scope-a");
    first.files.set("/persist/db/omeka.sqlite", new Uint8Array([1, 2, 3]));
    first.FS.write({ path: "/persist/db/omeka.sqlite" });
    first.FS.write({ path: "/persist/db/omeka.sqlite-journal" });
    first.FS.write({ path: "/www/omeka/cache.php" });

    const result = await persistence.flushNow();
    assert.deepEqual(result, {
      ok: true,
      flushedOps: 1,
      hydratedBytes: 3,
      estimatedBytes: 0,
    });
    const [stored] = [
      ...fakeIdb.databases.get("omeka-fs-journal:scope-a").get("ops"),
    ];
    assert.equal(stored.path, "/persist/db/omeka.sqlite");

    const second = createRawPhp();
    await initFsPersistence(second, "scope-a");
    assert.deepEqual(second.replayed, [["write", "/persist/db/omeka.sqlite"]]);
    assert.deepEqual(
      [...second.files.get("/persist/db/omeka.sqlite")],
      [1, 2, 3],
    );

    // Another scope is isolated.
    const other = createRawPhp();
    await initFsPersistence(other, "scope-b");
    assert.deepEqual(other.replayed, []);
  });

  it("skips journal ops that cannot be applied instead of failing the boot", async () => {
    const first = createRawPhp();
    const persistence = await initFsPersistence(first, "scope-c");
    first.files.set("/persist/files/a.jpg", new Uint8Array([9]));
    first.FS.write({ path: "/persist/files/a.jpg" });
    first.FS.unlink("/persist/files/gone.jpg");
    await persistence.flushNow();

    // gone.jpg was created in a non-journaled runtime: its DELETE throws.
    const second = createRawPhp();
    await initFsPersistence(second, "scope-c");
    assert.deepEqual(second.replayed, [
      ["write", "/persist/files/a.jpg"],
      ["write", "/persist/files/a.jpg"],
    ]);
  });

  it("stops a size-limited flush and keeps the ops pending", async () => {
    const raw = createRawPhp();
    const persistence = await initFsPersistence(raw, "scope-d");
    raw.files.set("/persist/files/big.bin", new Uint8Array(64));
    raw.FS.write({ path: "/persist/files/big.bin" });

    const limited = await persistence.flushNow({
      pathPrefix: "/persist/files",
      maxBytes: 10,
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.reason, "size-limit");
    assert.equal(limited.estimatedBytes, 64);

    const full = await persistence.flushNow({ pathPrefix: "/persist/files/" });
    assert.equal(full.flushedOps, 1);
  });

  it("clearJournal empties the scope's store", async () => {
    const raw = createRawPhp();
    const persistence = await initFsPersistence(raw, "scope-e");
    raw.files.set("/persist/x", new Uint8Array([1]));
    raw.FS.write({ path: "/persist/x" });
    await persistence.flushNow();
    assert.equal(
      fakeIdb.databases.get("omeka-fs-journal:scope-e").get("ops").length,
      1,
    );

    await clearJournal("scope-e");
    assert.equal(
      fakeIdb.databases.get("omeka-fs-journal:scope-e").get("ops").length,
      0,
    );
  });

  it("surfaces an IndexedDB open failure", async (t) => {
    fakeIdb.failOpen = true;
    t.after(() => {
      fakeIdb.failOpen = false;
    });
    await assert.rejects(
      initFsPersistence(createRawPhp(), "scope-f"),
      /open blocked/,
    );
  });
});

describe("operationTouchesPathPrefix", () => {
  it("matches everything without a prefix and tolerates missing paths", () => {
    assert.equal(operationTouchesPathPrefix({ path: "/x" }, null), true);
    assert.equal(operationTouchesPathPrefix(undefined, "/persist"), false);
    assert.equal(
      operationTouchesPathPrefix(
        { operation: "RENAME", path: "/tmp/a" },
        "/persist",
      ),
      false,
    );
  });
});

describe("flushPendingOps", () => {
  it("is a no-op when no pending op is selected", async () => {
    const pendingOps = [
      { operation: "WRITE", path: "/persist/db", nodeType: "file" },
    ];
    const result = await flushPendingOps({
      rawPhp: {},
      pendingOps,
      loadPersistedOps: () => assert.fail("must not read the journal"),
      replacePersistedOps: () => assert.fail("must not write the journal"),
      shouldFlush: () => false,
    });
    assert.deepEqual(result, {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(pendingOps.length, 1);
  });

  it("estimates only WRITE ops and treats unknown sizes as zero", async () => {
    const sized = [];
    const result = await flushPendingOps({
      rawPhp: { readFileAsBuffer: () => new Uint8Array(0) },
      pendingOps: [
        { operation: "CREATE", path: "/persist/dir", nodeType: "directory" },
        { operation: "WRITE", path: "/persist/a", nodeType: "file" },
      ],
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {},
      maxBytes: 100,
      getFileSize: (path) => {
        sized.push(path);
        return Number.NaN;
      },
    });
    assert.deepEqual(sized, ["/persist/a"]);
    assert.equal(result.ok, true);
    assert.equal(result.estimatedBytes, 0);
    assert.equal(result.hydratedBytes, 0);
  });
});
