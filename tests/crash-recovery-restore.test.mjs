import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSnapshotManager,
  isFatalWasmError,
  isSafeToReplay,
  requestPathname,
} from "../src/runtime/crash-recovery.js";
import { createFakeRawPhp } from "./helpers/fake-php.mjs";

const DB_PATH = "/persist/mutable/db/omeka.sqlite";
const UPLOADS = "/persist/mutable/files";
const ADDON_DIR = "/persist/addons/modules/Mapping";

// @php-wasm's listFiles(path, { prependPath }) returns absolute entries.
function rawPhpWith(files) {
  const raw = createFakeRawPhp({ files });
  const names = raw.listFiles;
  raw.listFiles = (path, options = {}) =>
    names(path).map((name) => (options.prependPath ? `${path}/${name}` : name));
  return raw;
}

function manager(options = {}) {
  const messages = [];
  const snapshot = createSnapshotManager({
    postShell: (message) => messages.push(message),
    ...options,
  });
  return { snapshot, messages, details: () => messages.map((m) => m.detail) };
}

describe("isFatalWasmError / isSafeToReplay / requestPathname", () => {
  it("classifies WASM crashes and ignores ordinary errors", () => {
    assert.equal(isFatalWasmError(null), false);
    assert.equal(isFatalWasmError(new WebAssembly.RuntimeError("x")), true);
    for (const message of [
      "memory access out of bounds",
      "unreachable executed",
      "RuntimeError: boom",
      "No file descriptors available",
      "Failed opening required 'x.php'",
    ]) {
      assert.equal(isFatalWasmError(new Error(message)), true, message);
    }
    assert.equal(isFatalWasmError("unreachable"), true);
    assert.equal(isFatalWasmError(new Error("404 not found")), false);
  });

  it("replays only GET and HEAD", () => {
    assert.equal(isSafeToReplay(undefined), true);
    assert.equal(isSafeToReplay({ method: "head" }), true);
    assert.equal(isSafeToReplay({ method: "POST" }), false);
  });

  it("falls back to / for unparsable request URLs", () => {
    assert.equal(requestPathname({ url: "http://[bad" }), "/");
    assert.equal(requestPathname({ url: "/admin?token=x" }), "/admin");
  });
});

describe("snapshot hydrate/restore round trip", () => {
  it("restores DB, tracked addon files and fallback uploads after a crash", async () => {
    const raw = rawPhpWith({
      [DB_PATH]: "db-v1",
      [`${UPLOADS}/original/a.jpg`]: "jpg",
      [`${ADDON_DIR}/Module.php`]: "<?php",
      [`${ADDON_DIR}/src/X.php`]: "<?php x",
    });
    const { snapshot, details } = manager();
    snapshot.trackAddonDir(ADDON_DIR);
    snapshot.trackAddonDir("/persist/addons/modules/Gone");

    const hydrated = await snapshot.hydrate({ _php: raw });
    assert.deepEqual(hydrated, { captured: true, filedirMode: "fallback" });
    assert.equal(snapshot.hasPendingRestore, true);

    // A fresh runtime after the crash: rebooted DB, no addons or uploads.
    const fresh = rawPhpWith({ [DB_PATH]: "db-rebooted" });
    const restored = await snapshot.restore({ _php: fresh });
    assert.deepEqual(restored, { restored: true, addonsRestored: true });
    assert.equal(fresh.readFileAsText(DB_PATH), "db-v1");
    assert.equal(fresh.readFileAsText(`${ADDON_DIR}/src/X.php`), "<?php x");
    assert.equal(fresh.readFileAsText(`${UPLOADS}/original/a.jpg`), "jpg");
    assert.equal(snapshot.hasPendingRestore, false);
    assert.ok(details().includes("[snapshot] saved 2 addon files"));
    assert.ok(details().includes("[snapshot] restored 2 addon files"));

    assert.deepEqual(await snapshot.restore({ _php: fresh }), {
      restored: false,
      addonsRestored: false,
    });
  });

  it("reports failed writes during restore", async () => {
    const raw = rawPhpWith({
      [DB_PATH]: "db",
      [`${UPLOADS}/u.txt`]: "u",
      [`${ADDON_DIR}/a.php`]: "a",
    });
    const { snapshot, details } = manager();
    snapshot.trackAddonDir(ADDON_DIR);
    await snapshot.hydrate({ _php: raw }, DB_PATH);

    const broken = rawPhpWith({});
    broken.writeFile = () => {
      throw new Error("disk full");
    };
    assert.deepEqual(await snapshot.restore({ _php: broken }), {
      restored: false,
      addonsRestored: false,
    });
    assert.ok(details().includes("[snapshot] failed to restore DB: disk full"));
    assert.ok(
      details().includes("[snapshot] restored 0 addon files (1 failed)"),
    );
    assert.ok(
      details().includes(
        "[snapshot] restored 0 fallback upload files (1 failed)",
      ),
    );
  });

  it("does not capture when the DB is missing or empty", async () => {
    const { snapshot, details } = manager();
    assert.deepEqual(await snapshot.hydrate({ _php: rawPhpWith({}) }), {
      captured: false,
      reason: "db-read-failed",
    });
    assert.deepEqual(
      await snapshot.hydrate({ _php: rawPhpWith({ [DB_PATH]: "" }) }),
      { captured: false, reason: "db-read-failed" },
    );
    assert.ok(details().some((d) => d.includes("DB snapshot is empty")));
    assert.equal(snapshot.hasPendingRestore, false);
  });

  it("skips unreadable upload and addon files, and reports unreadable addon dirs", async () => {
    const raw = rawPhpWith({
      [DB_PATH]: "db",
      [`${UPLOADS}/ok.txt`]: "ok",
      [`${UPLOADS}/locked.txt`]: "x",
      [`${ADDON_DIR}/locked.php`]: "x",
      "/persist/addons/not-a-dir": "x",
    });
    const read = raw.readFileAsBuffer;
    raw.readFileAsBuffer = (path) => {
      if (path.includes("locked")) throw new Error("EACCES");
      return read(path);
    };
    const fileExists = raw.fileExists;
    raw.fileExists = (path) => {
      if (path === "/persist/addons/broken") throw new Error("EIO");
      return fileExists(path);
    };
    const { snapshot, details } = manager();
    snapshot.trackAddonDir(ADDON_DIR);
    snapshot.trackAddonDir("/persist/addons/broken");
    snapshot.trackAddonDir("/persist/addons/not-a-dir");
    assert.equal((await snapshot.hydrate({ _php: raw })).captured, true);
    assert.ok(
      details().includes(
        "[snapshot] failed to read addon dir /persist/addons/broken: EIO",
      ),
    );
    const fresh = rawPhpWith({});
    assert.deepEqual(await snapshot.restore({ _php: fresh }), {
      restored: true,
      addonsRestored: false,
    });
    assert.equal(fresh.fileExists(`${UPLOADS}/locked.txt`), false);
    assert.equal(fresh.readFileAsText(`${UPLOADS}/ok.txt`), "ok");
  });

  it("clear() drops a pending snapshot", async () => {
    const { snapshot } = manager();
    await snapshot.hydrate({ _php: rawPhpWith({ [DB_PATH]: "db" }) });
    assert.equal(snapshot.hasPendingRestore, true);
    snapshot.clear();
    assert.equal(snapshot.hasPendingRestore, false);
  });
});

describe("upload checkpoint outcomes", () => {
  const dbOnly = () => rawPhpWith({ [DB_PATH]: "db" });

  it("names the size limit when the journal flush is too large", async () => {
    const { snapshot, details } = manager({ maxCrashFiledirBytes: 2048 });
    const php = {
      _php: dbOnly(),
      flushPersistence: async () => ({
        enabled: true,
        ok: false,
        reason: "size-limit",
        estimatedBytes: 4096,
      }),
    };
    assert.deepEqual(await snapshot.hydrate(php), {
      captured: false,
      reason: "size-limit",
    });
    assert.match(details()[0], /\(4KB exceeds 2KB limit\)/);
  });

  it("omits the size detail for other flush failures and defaults the reason", async () => {
    const { snapshot, details } = manager();
    const php = {
      _php: dbOnly(),
      flushPersistence: async () => ({ enabled: true, ok: false }),
    };
    assert.deepEqual(await snapshot.hydrate(php), {
      captured: false,
      reason: "filedir-checkpoint-failed",
    });
    assert.equal(
      details()[0],
      "[snapshot] upload checkpoint failed; using the last persisted checkpoint",
    );
  });

  it("treats a throwing flush as a failed checkpoint", async () => {
    const { snapshot, details } = manager();
    const php = {
      _php: dbOnly(),
      flushPersistence: async () => {
        throw new Error("idb closed");
      },
    };
    assert.deepEqual(await snapshot.hydrate(php), {
      captured: false,
      reason: "flush-failed",
    });
    assert.match(details()[0], /idb closed/);
  });

  it("falls back to the filesystem when persistence is disabled", async () => {
    const { snapshot, details } = manager();
    const php = {
      _php: dbOnly(),
      flushPersistence: async () => ({ enabled: false }),
    };
    assert.deepEqual(await snapshot.hydrate(php), {
      captured: true,
      filedirMode: "fallback",
    });
    assert.ok(details().includes("[snapshot] saved DB (2 bytes)"));
  });

  it("reports zero counts when the flush result omits them", async () => {
    const { snapshot, details } = manager();
    const php = {
      _php: dbOnly(),
      flushPersistence: async () => ({ enabled: true, ok: true }),
    };
    await snapshot.hydrate(php);
    assert.ok(
      details().includes("[snapshot] checkpointed 0 pending upload ops (0KB)"),
    );
  });

  it("skips the upload fallback without FS probes or when probing throws", async () => {
    const { snapshot } = manager();
    const bare = { readFileAsBuffer: () => new Uint8Array([1]) };
    assert.equal(
      (await snapshot.hydrate({ _php: bare })).filedirMode,
      "fallback",
    );

    const throwing = dbOnly();
    throwing.fileExists = (path) => {
      if (path === UPLOADS) throw new Error("EIO");
      return true;
    };
    assert.equal(
      (await snapshot.hydrate({ _php: throwing })).filedirMode,
      "fallback",
    );
  });

  it("tolerates an upload directory that cannot be listed", async () => {
    const raw = rawPhpWith({ [DB_PATH]: "db", [`${UPLOADS}/a`]: "a" });
    raw.listFiles = () => {
      throw new Error("EIO");
    };
    const { snapshot } = manager();
    await snapshot.hydrate({ _php: raw });
    const fresh = rawPhpWith({});
    await snapshot.restore({ _php: fresh });
    assert.equal(fresh.fileExists(`${UPLOADS}/a`), false);
  });

  it("stops the bounded fallback as soon as the limit is crossed", async () => {
    const raw = rawPhpWith({
      [DB_PATH]: "db",
      [`${UPLOADS}/a/1.bin`]: "x".repeat(800),
      [`${UPLOADS}/a/2.bin`]: "x".repeat(800),
      [`${UPLOADS}/b/3.bin`]: "x",
    });
    const { snapshot, details } = manager({ maxCrashFiledirBytes: 1024 });
    assert.deepEqual(await snapshot.hydrate({ _php: raw }), {
      captured: false,
      reason: "size-limit",
    });
    assert.match(details().at(-1), /exceeds 1KB; skipping live snapshot/);
  });
});
