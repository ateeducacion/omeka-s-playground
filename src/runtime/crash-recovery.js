/**
 * Crash recovery utilities for the PHP WASM runtime.
 *
 * Recovery strategy:
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - DB snapshot preserves session state across restarts.
 */

import { OMEKA_FILES_PATH, PLAYGROUND_DB_PATH } from "./bootstrap.js";

/**
 * Determine whether an error represents a fatal, unrecoverable WASM crash.
 */
export function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError) ||
    message.includes("memory access out of bounds") ||
    message.includes("unreachable") ||
    message.includes("RuntimeError") ||
    message.includes("No file descriptors available") ||
    message.includes("Failed opening required")
  );
}

/**
 * Determine whether a serialized request is safe to replay after a crash.
 */
export function isSafeToReplay(serializedRequest) {
  const method = String(serializedRequest?.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * Format an error into a human-readable string for display/logging.
 */
export function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return String(error.stack || error.message || error);
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Create a state snapshot manager for crash recovery.
 *
 * Before destroying the crashed runtime, read the DB file and addon files
 * from MEMFS (JS heap — works even with corrupted WASM linear memory).
 * After bootstrapping a fresh runtime, restore them.
 */
export function createSnapshotManager({ postShell }) {
  let savedDbSnapshot = null;
  let savedAddonFiles = null;
  let savedUploadFiles = null;
  const installedAddonDirs = new Set();

  function restoreFiles(rawPhp, files) {
    let ok = 0;
    let failed = 0;
    const createdDirs = new Set();

    for (const file of files) {
      try {
        const lastSlash = file.path.lastIndexOf("/");
        const parentDir =
          lastSlash > 0 ? file.path.substring(0, lastSlash) : null;
        if (parentDir && !createdDirs.has(parentDir)) {
          rawPhp.mkdirTree(parentDir);
          let dir = parentDir;
          while (dir && !createdDirs.has(dir)) {
            createdDirs.add(dir);
            dir = dir.substring(0, dir.lastIndexOf("/")) || null;
          }
        }
        rawPhp.writeFile(file.path, file.data);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  function collectFiles(rawPhp, dirPath) {
    const files = [];
    try {
      const entries = rawPhp.listFiles(dirPath, { prependPath: true });
      for (const entry of entries) {
        if (rawPhp.isDir(entry)) {
          files.push(...collectFiles(rawPhp, entry));
        } else {
          try {
            const data = rawPhp.readFileAsBuffer(entry);
            files.push({ path: entry, data: new Uint8Array(data) });
          } catch {
            // Unreadable file — skip
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read — skip
    }
    return files;
  }

  return {
    /**
     * Read the DB file and addon directories from the (possibly crashed)
     * runtime before it is destroyed.
     */
    async hydrate(php, dbPath) {
      const rawPhp = php._php;
      const effectiveDbPath = dbPath || PLAYGROUND_DB_PATH;

      // 1. Save the DB file
      try {
        const data = rawPhp.readFileAsBuffer(effectiveDbPath);
        if (data && data.byteLength > 0) {
          savedDbSnapshot = {
            path: effectiveDbPath,
            data: new Uint8Array(data),
          };
          postShell({
            kind: "trace",
            detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
          });
        }
      } catch (err) {
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}`,
        });
      }

      // 2. Save files from addon directories installed during this session
      if (installedAddonDirs.size > 0) {
        const allFiles = [];
        for (const dir of installedAddonDirs) {
          try {
            if (!rawPhp.fileExists(dir)) continue;
            const files = collectFiles(rawPhp, dir);
            if (files.length > 0) {
              allFiles.push(...files);
            }
          } catch (err) {
            postShell({
              kind: "error",
              detail: `[snapshot] failed to read addon dir ${dir}: ${err.message}`,
            });
          }
        }
        if (allFiles.length > 0) {
          savedAddonFiles = allFiles;
          postShell({
            kind: "trace",
            detail: `[snapshot] saved ${allFiles.length} addon files`,
          });
        }
      }

      // 3. Save uploaded files
      try {
        if (
          rawPhp.fileExists(OMEKA_FILES_PATH) &&
          rawPhp.isDir(OMEKA_FILES_PATH)
        ) {
          const files = collectFiles(rawPhp, OMEKA_FILES_PATH);
          if (files.length > 0) {
            savedUploadFiles = files;
            postShell({
              kind: "trace",
              detail: `[snapshot] saved ${files.length} upload files`,
            });
          }
        }
      } catch (err) {
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read uploads: ${err.message}`,
        });
      }
    },

    /**
     * Restore the saved DB and addon files onto a fresh runtime.
     */
    async restore(php) {
      if (!savedDbSnapshot && !savedAddonFiles && !savedUploadFiles) {
        return { restored: false, addonsRestored: false };
      }
      const rawPhp = php._php;
      let restored = false;
      let addonsRestored = false;

      if (savedDbSnapshot) {
        try {
          rawPhp.writeFile(savedDbSnapshot.path, savedDbSnapshot.data);
          postShell({
            kind: "trace",
            detail: `[snapshot] restored DB (${savedDbSnapshot.data.byteLength} bytes)`,
          });
          restored = true;
        } catch (err) {
          postShell({
            kind: "error",
            detail: `[snapshot] failed to restore DB: ${err.message}`,
          });
        }
        savedDbSnapshot = null;
      }

      if (savedAddonFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedAddonFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} addon files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
          addonsRestored = true;
        }
        savedAddonFiles = null;
      }

      if (savedUploadFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedUploadFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} upload files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
        }
        savedUploadFiles = null;
      }

      return { restored, addonsRestored };
    },

    get hasPendingRestore() {
      return (
        savedDbSnapshot !== null ||
        savedAddonFiles !== null ||
        savedUploadFiles !== null
      );
    },

    trackAddonDir(dirPath) {
      installedAddonDirs.add(dirPath);
      postShell({
        kind: "trace",
        detail: `[snapshot] tracking installed addon: ${dirPath}`,
      });
    },

    clear() {
      savedDbSnapshot = null;
      savedAddonFiles = null;
      savedUploadFiles = null;
    },
  };
}
