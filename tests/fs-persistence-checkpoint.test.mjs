import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  flushPendingOps,
  operationTouchesPathPrefix,
} from "../src/runtime/fs-persistence.js";

const UPLOADS_PATH = "/persist/mutable/files";

describe("selective persistence checkpoints", () => {
  it("flushes only upload operations and leaves unrelated DB work pending", async () => {
    const filePath = `${UPLOADS_PATH}/item-1/image.jpg`;
    const dbOp = {
      operation: "WRITE",
      path: "/persist/mutable/db/omeka.sqlite",
      nodeType: "file",
    };
    const pendingOps = [
      dbOp,
      { operation: "WRITE", path: filePath, nodeType: "file" },
      { operation: "WRITE", path: filePath, nodeType: "file" },
    ];
    let reads = 0;
    let persisted = [];

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer(path) {
          assert.equal(path, filePath);
          reads++;
          return new Uint8Array([1, 2, 3]);
        },
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async (ops) => {
        persisted = ops;
      },
      shouldFlush: (op) => operationTouchesPathPrefix(op, UPLOADS_PATH),
      maxBytes: 1024,
      getFileSize: () => 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 1);
    assert.equal(result.hydratedBytes, 3);
    assert.equal(reads, 1);
    assert.deepEqual(pendingOps, [dbOp]);
    assert.equal(persisted.length, 1);
    assert.deepEqual([...persisted[0].data], [1, 2, 3]);
  });

  it("rejects an oversized crash checkpoint before reading file contents", async () => {
    const fileOp = {
      operation: "WRITE",
      path: `${UPLOADS_PATH}/large-file`,
      nodeType: "file",
    };
    const pendingOps = [fileOp];
    let reads = 0;
    let writes = 0;

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer() {
          reads++;
          return new Uint8Array(32);
        },
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {
        writes++;
      },
      maxBytes: 8,
      getFileSize: () => 32,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(result.estimatedBytes, 32);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.deepEqual(pendingOps, [fileOp]);
  });

  it("restores selected operations to pending queue when persistence fails", async () => {
    const fileOp = {
      operation: "WRITE",
      path: `${UPLOADS_PATH}/file`,
      nodeType: "file",
    };
    const pendingOps = [fileOp];

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer: () => new Uint8Array([1]),
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "flush-failed");
    assert.deepEqual(pendingOps, [fileOp]);
  });

  it("matches renames entering or leaving upload tree", () => {
    assert.equal(
      operationTouchesPathPrefix(
        {
          operation: "RENAME",
          path: "/tmp/upload",
          toPath: `${UPLOADS_PATH}/new-file`,
          nodeType: "file",
        },
        UPLOADS_PATH,
      ),
      true,
    );
    assert.equal(
      operationTouchesPathPrefix(
        {
          operation: "RENAME",
          path: `${UPLOADS_PATH}/old-file`,
          toPath: "/tmp/removed",
          nodeType: "file",
        },
        UPLOADS_PATH,
      ),
      true,
    );
  });
});
