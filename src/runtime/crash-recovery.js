/**
 * Crash recovery utilities for the PHP WASM runtime.
 *
 * Recovery strategy:
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - Pending upload journal changes are checkpointed before DB snapshot.
 */

import { OMEKA_FILES_PATH, PLAYGROUND_DB_PATH } from "./bootstrap.js";

const FILEDIR_PATH = OMEKA_FILES_PATH;
const DEFAULT_MAX_CRASH_FILEDIR_BYTES = 16 * 1024 * 1024;

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
 * The persisted filesystem journal remains the source of truth for uploads.
 * Before capturing the DB, the manager flushes only pending upload operations
 * to keep DB + files coherent without traversing the whole upload tree.
 */
export function createSnapshotManager({
  postShell,
  maxCrashFiledirBytes = DEFAULT_MAX_CRASH_FILEDIR_BYTES,
}) {
  let savedDbSnapshot = null;
  let savedAddonFiles = null;
  let savedUploadFiles = null;
  const installedAddonDirs = new Set();

  function clearSavedState() {
    savedDbSnapshot = null;
    savedAddonFiles = null;
    savedUploadFiles = null;
  }

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

  function collectFilesBounded(rawPhp, dirPath, maxBytes) {
    const files = [];
    let totalBytes = 0;
    let exceeded = false;

    const visit = (path) => {
      if (exceeded) return;
      let entries;
      try {
        entries = rawPhp.listFiles(path, { prependPath: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (exceeded) return;
        if (rawPhp.isDir(entry)) {
          visit(entry);
          continue;
        }

        try {
          const data = new Uint8Array(rawPhp.readFileAsBuffer(entry));
          if (totalBytes + data.byteLength > maxBytes) {
            exceeded = true;
            files.length = 0;
            return;
          }
          totalBytes += data.byteLength;
          files.push({ path: entry, data });
        } catch {
          // Unreadable file — skip
        }
      }
    };

    visit(dirPath);
    return { exceeded, files, totalBytes };
  }

  async function prepareFiledirCheckpoint(php, rawPhp) {
    if (typeof php.flushPersistence === "function") {
      try {
        const result = await php.flushPersistence({
          pathPrefix: FILEDIR_PATH,
          maxBytes: maxCrashFiledirBytes,
        });

        if (result?.enabled) {
          if (!result.ok) {
            const sizeDetail =
              result.reason === "size-limit"
                ? ` (${Math.round((result.estimatedBytes || 0) / 1024)}KB exceeds ${Math.round(maxCrashFiledirBytes / 1024)}KB limit)`
                : "";
            postShell({
              kind: "error",
              detail: `[snapshot] upload checkpoint failed${sizeDetail}; using the last persisted checkpoint`,
            });
            return { ok: false, mode: "journal", reason: result.reason };
          }

          postShell({
            kind: "trace",
            detail: `[snapshot] checkpointed ${result.flushedOps || 0} pending upload ops (${Math.round((result.hydratedBytes || 0) / 1024)}KB)`,
          });
          return { ok: true, mode: "journal" };
        }
      } catch (error) {
        postShell({
          kind: "error",
          detail: `[snapshot] upload checkpoint failed: ${error.message}; using the last persisted checkpoint`,
        });
        return { ok: false, mode: "journal", reason: "flush-failed" };
      }
    }

    if (
      typeof rawPhp?.fileExists !== "function" ||
      typeof rawPhp?.isDir !== "function"
    ) {
      return { ok: true, mode: "fallback", files: [] };
    }

    let hasUploads = false;
    try {
      hasUploads =
        rawPhp.fileExists(FILEDIR_PATH) && rawPhp.isDir(FILEDIR_PATH);
    } catch {
      return { ok: true, mode: "fallback", files: [] };
    }
    if (!hasUploads) {
      return { ok: true, mode: "fallback", files: [] };
    }

    const fallback = collectFilesBounded(
      rawPhp,
      FILEDIR_PATH,
      maxCrashFiledirBytes,
    );
    if (fallback.exceeded) {
      postShell({
        kind: "error",
        detail: `[snapshot] bounded upload fallback exceeds ${Math.round(maxCrashFiledirBytes / 1024)}KB; skipping live snapshot`,
      });
      return { ok: false, mode: "fallback", reason: "size-limit" };
    }

    postShell({
      kind: "trace",
      detail: `[snapshot] saved bounded upload fallback (${fallback.files.length} entries, ${Math.round(fallback.totalBytes / 1024)}KB)`,
    });
    return { ok: true, mode: "fallback", files: fallback.files };
  }

  return {
    async hydrate(php, dbPath) {
      clearSavedState();
      const rawPhp = php._php;
      const effectiveDbPath = dbPath || PLAYGROUND_DB_PATH;
      const filedirCheckpoint = await prepareFiledirCheckpoint(php, rawPhp);

      if (!filedirCheckpoint.ok) {
        return {
          captured: false,
          reason: filedirCheckpoint.reason || "filedir-checkpoint-failed",
        };
      }

      if (
        filedirCheckpoint.mode === "fallback" &&
        filedirCheckpoint.files.length > 0
      ) {
        savedUploadFiles = filedirCheckpoint.files;
      }

      try {
        const data = rawPhp.readFileAsBuffer(effectiveDbPath);
        if (!data || data.byteLength === 0) {
          throw new Error("DB snapshot is empty");
        }
        savedDbSnapshot = {
          path: effectiveDbPath,
          data: new Uint8Array(data),
        };
        postShell({
          kind: "trace",
          detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
        });
      } catch (err) {
        clearSavedState();
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}; using the last persisted checkpoint`,
        });
        return { captured: false, reason: "db-read-failed" };
      }

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

      return {
        captured: true,
        filedirMode: filedirCheckpoint.mode,
      };
    },

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
          detail: `[snapshot] restored ${ok} fallback upload files${failed > 0 ? ` (${failed} failed)` : ""}`,
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
      clearSavedState();
    },
  };
}
