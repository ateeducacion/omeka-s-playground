import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collapseAndHydrate,
  createJournalFlusher,
} from "../src/runtime/fs-persistence.js";

// Regression guard for the journal-flush OOM: a heavy install rewrites the same
// (multi-MB) SQLite DB hundreds of times within one debounce window. Hydrating
// the raw, un-collapsed op list read every write's content into memory at once →
// `RangeError: Array buffer allocation failed`. collapseAndHydrate must normalize
// FIRST (collapsing same-path writes) so each changed file is read exactly once.
test("collapseAndHydrate reads each changed file once, not once per write", async () => {
  const path = "/persist/data.sq3";
  const ops = Array.from({ length: 500 }, () => ({
    operation: "WRITE",
    path,
    nodeType: "file",
  }));

  const reads = new Map();
  const fakePhp = {
    readFileAsBuffer(p) {
      reads.set(p, (reads.get(p) || 0) + 1);
      return new Uint8Array(8);
    },
  };

  const hydrated = await collapseAndHydrate(fakePhp, ops);

  // 500 writes to one path collapse to a single WRITE op...
  const writes = hydrated.filter(
    (op) => op.operation === "WRITE" && op.path === path,
  );
  assert.equal(writes.length, 1);
  // ...and the file is read exactly once (the OOM guard), not 500 times.
  assert.equal(reads.get(path), 1);
});

// Fake IndexedDB handle: getAll() answers on the next microtask, and a
// readwrite transaction only commits (and fires oncomplete) once release() runs,
// standing in for a slow journal rewrite that is still in flight.
function slowPersistDb() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const committed = [];
  const db = {
    transaction(_storeName, mode) {
      let staged = [];
      const tx = {
        objectStore: () => ({
          getAll() {
            const req = {};
            queueMicrotask(() => {
              req.result = [...committed];
              req.onsuccess?.();
            });
            return req;
          },
          clear() {
            staged = [];
          },
          add(op) {
            staged.push(op);
          },
        }),
      };
      if (mode === "readwrite") {
        gate.then(() => {
          committed.splice(0, committed.length, ...staged);
          tx.oncomplete?.();
        });
      }
      return tx;
    },
  };
  return { db, committed, release };
}

test("flushNow waits for a debounced flush that is already mid-transaction", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const path = "/persist/install.marker";
  const rawPhp = { readFileAsBuffer: () => new Uint8Array([1]) };
  const { db, committed, release } = slowPersistDb();
  const pendingOps = [{ operation: "WRITE", path, nodeType: "file" }];
  const flusher = createJournalFlusher(rawPhp, db, pendingOps);

  // The debounce fires: the flush drains pendingOps and blocks in the
  // IndexedDB transaction.
  flusher.scheduleFlush();
  t.mock.timers.tick(1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingOps.length, 0, "the debounced flush drained the ops");

  let settled = false;
  const flushed = flusher.flushNow().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "flushNow resolved while the drained ops were still uncommitted",
  );

  release();
  await flushed;
  assert.deepEqual(
    committed.map((op) => op.path),
    [path],
  );
});
