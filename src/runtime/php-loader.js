import {
  __private__dont__use,
  PHP,
  setPhpIniEntries,
} from "@php-wasm/universal";
import {
  certificateToPEM,
  generateCertificate,
  loadWebRuntime,
} from "@php-wasm/web";
import { OMEKA_ROOT } from "./bootstrap.js";
import { wrapPhpInstance } from "./php-compat.js";
import { registerSpawnHandler } from "./spawn-handler.js";

const PERSIST_ROOT = "/persist";
const TEMP_ROOT = "/tmp";
const DEFAULT_PHP_VERSION = "8.3";

const TCP_OVER_FETCH_CA_PATH = "/internal/shared/playground-ca.pem";
let cachedTcpOverFetchCaPromise = null;

async function getTcpOverFetchOptions(corsProxyUrl) {
  if (!cachedTcpOverFetchCaPromise) {
    cachedTcpOverFetchCaPromise = generateCertificate({
      subject: {
        commonName: "Omeka S Playground CA",
        organizationName: "Omeka S Playground",
        countryName: "ES",
      },
      basicConstraints: { ca: true },
    });
  }
  return {
    CAroot: await cachedTcpOverFetchCaPromise,
    ...(corsProxyUrl ? { corsProxyUrl } : {}),
  };
}

/**
 * Create the primary PHP CGI runtime for serving Omeka requests.
 *
 * Returns a deferred object:
 * - Call refresh() to initialize the runtime (loads WASM)
 * - Then use request(), writeFile(), readFile(), etc.
 */
export function createPhpRuntime(
  _runtime,
  {
    appBaseUrl,
    phpVersion,
    webRoot,
    corsProxyUrl,
    phpCorsProxyUrl,
    cliExecutor,
  } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  let wrapped = null;

  const deferred = {
    async refresh() {
      const resolvedCorsProxyUrl = corsProxyUrl ?? phpCorsProxyUrl ?? null;
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await loadWebRuntime(resolvedPhpVersion, {
        withIntl: true,
        tcpOverFetch,
      });
      const php = new PHP(runtimeId);
      const FS = php[__private__dont__use].FS;

      // Ensure directories exist
      try {
        FS.mkdirTree(TEMP_ROOT);
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree(OMEKA_ROOT);
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree(PERSIST_ROOT);
      } catch {
        /* exists */
      }

      php.writeFile(
        TCP_OVER_FETCH_CA_PATH,
        `${certificateToPEM(tcpOverFetch.CAroot.certificate)}\n`,
      );

      // Apply php.ini settings
      await setPhpIniEntries(php, {
        memory_limit: "256M",
        max_execution_time: "300",
        display_errors: "On",
        error_reporting: "E_ALL",
        "session.save_path": "/persist/mutable/session",
        upload_tmp_dir: "/tmp",
        "date.timezone": "UTC",
        "openssl.cafile": TCP_OVER_FETCH_CA_PATH,
        "curl.cainfo": TCP_OVER_FETCH_CA_PATH,
        // OPcache tuning — use in-memory file cache with a high file limit
        // and no timestamp checks (the readonly bundle never changes within
        // a session), so PHP avoids recompiling on every request.
        "opcache.enable": "1",
        "opcache.file_cache": "/internal/shared/opcache",
        "opcache.file_cache_only": "1",
        "opcache.max_accelerated_files": "10000",
        "opcache.memory_consumption": "128",
        "opcache.interned_strings_buffer": "32",
        "opcache.validate_timestamps": "0",
        "opcache.file_cache_consistency_checks": "0",
      });

      // Write preload dir for WP Playground's internal preload mechanism
      try {
        FS.mkdirTree("/internal/shared/preload");
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree("/internal/shared/opcache");
      } catch {
        /* exists */
      }

      if (typeof cliExecutor === "function") {
        // Only the primary request runtime gets a spawn handler. CLI runtimes
        // are short-lived and should not recursively spawn more PHP processes.
        await registerSpawnHandler(php, cliExecutor);
      }

      const absoluteUrl = (appBaseUrl || "http://localhost:8080").replace(
        /\/$/u,
        "",
      );
      wrapped = wrapPhpInstance(php, {
        syncFs: null,
        absoluteUrl,
        webRoot: webRoot || OMEKA_ROOT,
      });

      // Copy all methods from the wrapped instance onto this deferred object
      for (const key of Object.keys(wrapped)) {
        if (key !== "refresh") {
          deferred[key] = wrapped[key];
        }
      }

      Object.defineProperty(deferred, "binary", {
        get() {
          return wrapped.binary;
        },
        configurable: true,
      });
      Object.defineProperty(deferred, "_php", {
        get() {
          return wrapped._php;
        },
        configurable: true,
      });
    },

    // Placeholder methods that throw if called before refresh()
    async request() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async analyzePath() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async mkdir() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async writeFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async readFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async run() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}
