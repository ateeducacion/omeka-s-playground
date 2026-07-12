import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSnapshotManager } from "../src/runtime/crash-recovery.js";

const DB_PATH = "/persist/mutable/db/omeka.sqlite";
const UPLOADS_PATH = "/persist/mutable/files";

function createMessages() {
  const messages = [];
  return {
    messages,
    postShell: (message) => messages.push(message),
  };
}

describe("crash recovery checkpoints", () => {
  it("flushes pending uploads before taking DB snapshot", async () => {
    const { messages, postShell } = createMessages();
    const flushCalls = [];
    let dbReads = 0;
    const rawPhp = {
      readFileAsBuffer(path) {
        assert.equal(path, DB_PATH);
        dbReads++;
        return new Uint8Array([1, 2, 3]);
      },
      fileExists() {
        throw new Error("full upload traversal must not run");
      },
    };
    const php = {
      _php: rawPhp,
      async flushPersistence(options) {
        flushCalls.push(options);
        return {
          enabled: true,
          ok: true,
          flushedOps: 2,
          hydratedBytes: 1024,
          estimatedBytes: 1024,
        };
      },
    };
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 4096,
    });

    const result = await snapshot.hydrate(php, DB_PATH);

    assert.deepEqual(result, { captured: true, filedirMode: "journal" });
    assert.equal(dbReads, 1);
    assert.deepEqual(flushCalls, [
      { pathPrefix: UPLOADS_PATH, maxBytes: 4096 },
    ]);
    assert.equal(snapshot.hasPendingRestore, true);
    assert.ok(
      messages.some((message) =>
        message.detail?.includes("checkpointed 2 pending upload ops"),
      ),
    );
  });

  it("does not capture newer DB when upload checkpoint fails", async () => {
    const { postShell } = createMessages();
    let dbReads = 0;
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 4096,
    });
    const php = {
      _php: {
        readFileAsBuffer() {
          dbReads++;
          return new Uint8Array([1]);
        },
      },
      async flushPersistence() {
        return {
          enabled: true,
          ok: false,
          reason: "size-limit",
          estimatedBytes: 8192,
        };
      },
    };

    const result = await snapshot.hydrate(php, DB_PATH);

    assert.equal(result.captured, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(dbReads, 0);
    assert.equal(snapshot.hasPendingRestore, false);
  });

  it("uses bounded upload fallback when persistence is disabled", async () => {
    const { postShell } = createMessages();
    const storedFile = `${UPLOADS_PATH}/item-1/image.jpg`;
    const rawPhp = {
      fileExists(path) {
        return path === UPLOADS_PATH;
      },
      isDir(path) {
        return path === UPLOADS_PATH || path === `${UPLOADS_PATH}/item-1`;
      },
      listFiles(path) {
        if (path === UPLOADS_PATH) return [`${UPLOADS_PATH}/item-1`];
        if (path === `${UPLOADS_PATH}/item-1`) return [storedFile];
        return [];
      },
      readFileAsBuffer(path) {
        if (path === DB_PATH) return new Uint8Array([9, 8]);
        if (path === storedFile) return new Uint8Array([7, 6, 5]);
        throw new Error(`unexpected read: ${path}`);
      },
    };
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 1024,
    });

    const result = await snapshot.hydrate(
      {
        _php: rawPhp,
        async flushPersistence() {
          return { enabled: false, ok: true };
        },
      },
      DB_PATH,
    );

    assert.deepEqual(result, { captured: true, filedirMode: "fallback" });

    const writes = new Map();
    const restoreResult = await snapshot.restore({
      _php: {
        mkdirTree() {},
        writeFile(path, data) {
          writes.set(path, [...data]);
        },
      },
    });

    assert.equal(restoreResult.restored, true);
    assert.deepEqual(writes.get(DB_PATH), [9, 8]);
    assert.deepEqual(writes.get(storedFile), [7, 6, 5]);
    assert.equal(snapshot.hasPendingRestore, false);
  });

  it("abandons live snapshot when bounded fallback exceeds limit", async () => {
    const { postShell } = createMessages();
    const storedFile = `${UPLOADS_PATH}/large-file`;
    let dbReads = 0;
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 3,
    });

    const result = await snapshot.hydrate(
      {
        _php: {
          fileExists: () => true,
          isDir: (path) => path === UPLOADS_PATH,
          listFiles: () => [storedFile],
          readFileAsBuffer(path) {
            if (path === DB_PATH) {
              dbReads++;
              return new Uint8Array([1]);
            }
            return new Uint8Array([1, 2, 3, 4]);
          },
        },
        async flushPersistence() {
          return { enabled: false, ok: true };
        },
      },
      DB_PATH,
    );

    assert.equal(result.captured, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(dbReads, 0);
    assert.equal(snapshot.hasPendingRestore, false);
  });
});
