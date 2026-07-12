import {
  hydrateUpdateFileOps,
  journalFSEvents,
  normalizeFilesystemOperations,
  replayFSJournal,
} from "@php-wasm/fs-journal";
import { __private__dont__use } from "@php-wasm/universal";

// Persist Omeka's mutable state (SQLite DB, uploads, config under /persist) to
// IndexedDB via @php-wasm/fs-journal, keyed by scopeId, so it survives reloads
// within the tab session (scopeId is sessionStorage-based — same durability as
// the nextcloud/facturascripts playgrounds). The bootstrap install gate
// (`$status->isInstalled()`) then finds the persisted DB and skips re-install.
// OPcache is intentionally NOT journaled (measured no boot benefit; large cache).
const PERSIST_DB_PREFIX = "omeka-fs-journal";
const DB_VERSION = 1;
const STORE_NAME = "ops";
const FLUSH_DELAY_MS = 1500;

function pathMatchesPrefix(path, pathPrefix) {
  if (!pathPrefix) return true;
  const normalizedPrefix = String(pathPrefix).replace(/\/$/u, "");
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

export function operationTouchesPathPrefix(operation, pathPrefix) {
  if (pathMatchesPrefix(operation?.path || "", pathPrefix)) {
    return true;
  }
  return (
    operation?.operation === "RENAME" &&
    pathMatchesPrefix(operation.toPath || "", pathPrefix)
  );
}

async function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOps(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function replaceOps(db, ops) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const op of ops) {
      store.add(op);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearDb(name) {
  const db = await openDb(name);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Collapse the raw journal ops, THEN hydrate only the survivors — the canonical
// fs-journal order (WordPress Playground's hydrate-fs-writes middleware does
// `hydrateUpdateFileOps(php, normalizeFilesystemOperations(ops))`). Hydrating the
// raw, un-collapsed list reads every write's content into memory: a heavy install
// rewrites the multi-MB SQLite DB hundreds of times within one flush window, so
// hydrating each one OOMs ("Array buffer allocation failed"). Normalizing first
// collapses the repeated same-path writes (and folds write-temp + rename) so each
// changed file is read exactly once.
export async function collapseAndHydrate(rawPhp, ops) {
  return hydrateUpdateFileOps(rawPhp, normalizeFilesystemOperations(ops));
}

function estimateWriteBytes(rawPhp, ops, getFileSize) {
  const resolveFileSize =
    getFileSize ||
    ((path) => rawPhp[__private__dont__use].FS.stat(path).size || 0);
  let estimatedBytes = 0;
  for (const op of ops) {
    if (op.operation !== "WRITE") continue;
    estimatedBytes += Number(resolveFileSize(op.path)) || 0;
  }
  return estimatedBytes;
}

export async function flushPendingOps({
  rawPhp,
  pendingOps,
  loadPersistedOps,
  replacePersistedOps,
  shouldFlush = () => true,
  maxBytes = Number.POSITIVE_INFINITY,
  getFileSize = null,
}) {
  const selectedOps = [];
  const remainingOps = [];
  for (const op of pendingOps) {
    if (shouldFlush(op)) {
      selectedOps.push(op);
    } else {
      remainingOps.push(op);
    }
  }

  if (selectedOps.length === 0) {
    return {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    };
  }

  pendingOps.splice(0, pendingOps.length, ...remainingOps);
  const normalizedOps = normalizeFilesystemOperations(selectedOps);

  let estimatedBytes = 0;
  try {
    if (Number.isFinite(maxBytes)) {
      estimatedBytes = estimateWriteBytes(rawPhp, normalizedOps, getFileSize);
      if (estimatedBytes > maxBytes) {
        pendingOps.unshift(...selectedOps);
        return {
          ok: false,
          reason: "size-limit",
          flushedOps: 0,
          hydratedBytes: 0,
          estimatedBytes,
        };
      }
    }

    const hydrated = await hydrateUpdateFileOps(rawPhp, normalizedOps);
    const current = await loadPersistedOps();
    const merged = normalizeFilesystemOperations([...current, ...hydrated]);
    await replacePersistedOps(merged);
    const hydratedBytes = hydrated.reduce(
      (sum, op) =>
        sum + (op.operation === "WRITE" ? op.data?.byteLength || 0 : 0),
      0,
    );
    return {
      ok: true,
      flushedOps: hydrated.length,
      hydratedBytes,
      estimatedBytes,
    };
  } catch (error) {
    pendingOps.unshift(...selectedOps);
    return {
      ok: false,
      reason: "flush-failed",
      error,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes,
    };
  }
}

function createJournalFlusher(rawPhp, persistDb, pendingOps) {
  let flushTimer = null;
  let flushQueue = Promise.resolve();

  const enqueueFlush = (options = {}) => {
    const run = flushQueue.then(() =>
      flushPendingOps({
        rawPhp,
        pendingOps,
        loadPersistedOps: () => loadOps(persistDb),
        replacePersistedOps: (ops) => replaceOps(persistDb, ops),
        ...options,
      }),
    );
    flushQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await enqueueFlush();
    }, FLUSH_DELAY_MS);
  };

  const flushNow = async ({ pathPrefix = null, maxBytes } = {}) => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const shouldFlush = pathPrefix
      ? (op) => operationTouchesPathPrefix(op, pathPrefix)
      : () => true;
    const aggregate = {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    };

    while (pendingOps.some(shouldFlush)) {
      const result = await enqueueFlush({ shouldFlush, maxBytes });
      aggregate.flushedOps += result.flushedOps || 0;
      aggregate.hydratedBytes += result.hydratedBytes || 0;
      aggregate.estimatedBytes += result.estimatedBytes || 0;
      if (!result.ok) {
        return { ...aggregate, ...result, ok: false };
      }
    }

    return aggregate;
  };

  return { flushNow, scheduleFlush };
}

export async function clearJournal(scopeId) {
  await clearDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
}

/**
 * Replay the journal, tolerating ops that can't be applied to a fresh FS so a
 * single bad op never bricks the reload. This happens because Omeka writes media
 * in an isolated CLI runtime (cli-runtime.js) whose creates aren't journaled,
 * while the user's later delete (in the main runtime) is — leaving a dangling
 * unlink. Fast path replays the whole batch; on any failure, replay op-by-op and
 * skip the ones that throw (a failed unlink just means the file is already gone,
 * which is the intended end state).
 */
function replayResilient(rawPhp, ops) {
  if (!ops || ops.length === 0) return;
  try {
    replayFSJournal(rawPhp, ops);
  } catch {
    for (const op of ops) {
      try {
        replayFSJournal(rawPhp, [op]);
      } catch {
        // Skip un-appliable op.
      }
    }
  }
}

/**
 * Replay the persisted /persist journal onto the fresh PHP instance, then start
 * journaling new changes back to IndexedDB (debounced). Must run before the app
 * bootstraps so the install gate sees the restored database.
 */
export async function initFsPersistence(rawPhp, scopeId) {
  const persistDb = await openDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
  const pendingPersistOps = [];
  const flusher = createJournalFlusher(rawPhp, persistDb, pendingPersistOps);

  // Journal /persist — mutable app data (DB, uploads, config). Skip ephemeral
  // SQLite temp files: they are created and deleted within a single transaction
  // and cause hydration failures if journaled.
  journalFSEvents(rawPhp, "/persist", (op) => {
    if (/\.(sqlite-journal|sqlite-wal|sqlite-shm)$/.test(op.path || "")) return;
    pendingPersistOps.push(op);
    flusher.scheduleFlush();
  });

  const savedPersistOps = await loadOps(persistDb);
  replayResilient(rawPhp, savedPersistOps);

  return {
    flushNow: flusher.flushNow,
  };
}
