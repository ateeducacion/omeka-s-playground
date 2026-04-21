import {
  buildManifestFilename,
  DEFAULT_OMEKA_VERSION,
} from "../src/shared/omeka-versions.js";
import { resolveProjectUrl } from "../src/shared/paths.js";
import { unzipSync } from "../vendor/fflate/esm/browser.js";

const CACHE_NAME = "omeka-playground-bundles";
const DEFAULT_MANIFEST_URL = resolveProjectUrl(
  `assets/manifests/${buildManifestFilename(DEFAULT_OMEKA_VERSION)}`,
).toString();

/**
 * Download a resource with streaming progress reporting.
 */
export async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!contentLength || !response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total: buffer.byteLength, ratio: 1 });
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({
      loaded,
      total: contentLength,
      ratio: Math.min(loaded / contentLength, 1),
    });
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Load and normalize a manifest JSON file.
 */
export async function fetchManifest(manifestUrl) {
  const url = manifestUrl || DEFAULT_MANIFEST_URL;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load manifest: ${response.status}`);
  }
  const manifest = await response.json();
  manifest._manifestUrl = url.toString();
  return manifest;
}

/**
 * Compute SHA-256 hex digest of a Uint8Array.
 */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the absolute bundle URL from a manifest.
 */
function resolveBundleUrl(manifest) {
  const bundlePath = manifest.bundle?.path;
  if (!bundlePath) {
    throw new Error("Manifest does not describe a bundle.");
  }
  return new URL(bundlePath, manifest._manifestUrl).toString();
}

/**
 * Download the bundle ZIP with Cache API caching and SHA-256 verification.
 */
export async function fetchBundleWithCache(manifest, onProgress) {
  const url = resolveBundleUrl(manifest);
  const expectedSha = manifest.bundle?.sha256;

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable (e.g. opaque origin); fall through to network.
  }

  if (cache) {
    const cached = await cache.match(url);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (expectedSha) {
        const actual = await sha256Hex(bytes);
        if (actual === expectedSha) {
          onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
          return bytes;
        }
        // Hash mismatch — discard and re-download.
        await cache.delete(url);
      } else {
        onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
        return bytes;
      }
    }
  }

  const bytes = await fetchWithProgress(url, onProgress);

  if (expectedSha) {
    const actual = await sha256Hex(bytes);
    if (actual !== expectedSha) {
      throw new Error(
        `Bundle SHA-256 mismatch: expected ${expectedSha}, got ${actual}`,
      );
    }
  }

  if (cache) {
    try {
      const resp = new Response(bytes, {
        headers: { "content-type": "application/zip" },
      });
      await cache.put(url, resp);
    } catch {
      // Non-fatal — caching is best-effort.
    }
  }

  return bytes;
}

/**
 * Main entry point: load manifest + download bundle.
 */
export async function resolveBootstrapArchive(options = {}, onProgress) {
  const manifest = await fetchManifest(options.manifestUrl);
  const bytes = await fetchBundleWithCache(manifest, onProgress);
  return { manifest, bytes };
}

/**
 * Extract ZIP entries using fflate, normalize paths, strip leading folder.
 */
export function extractZipEntries(zipBytes) {
  const raw = unzipSync(zipBytes);
  const paths = Object.keys(raw);

  // Detect common leading folder to strip (e.g. "omeka/" prefix).
  let prefix = "";
  if (paths.length > 0) {
    const first = paths[0];
    const slashIndex = first.indexOf("/");
    if (slashIndex !== -1) {
      const candidate = first.slice(0, slashIndex + 1);
      const allMatch = paths.every((p) => p.startsWith(candidate));
      if (allMatch) {
        prefix = candidate;
      }
    }
  }

  const entries = [];
  for (const [rawPath, data] of Object.entries(raw)) {
    // Skip directory entries (empty data, trailing slash).
    if (rawPath.endsWith("/") && data.byteLength === 0) {
      continue;
    }
    const path = prefix ? rawPath.slice(prefix.length) : rawPath;
    if (!path) continue;
    entries.push({ path, data });
  }

  return entries;
}

/**
 * Write extracted entries to the Emscripten FS.
 */
export function writeEntriesToPhp(php, entries, targetRoot, onProgress) {
  const FS = php.FS ?? (php.binary && php.binary.FS);

  function ensureDir(dirPath) {
    const segments = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = `${current}/${segment}`;
      const info = FS.analyzePath(current);
      if (!info?.exists) {
        try {
          FS.mkdir(current);
        } catch {
          // Already exists.
        }
      }
    }
  }

  ensureDir(targetRoot);

  const total = entries.length;
  for (let i = 0; i < total; i++) {
    const entry = entries[i];
    const fullPath = `${targetRoot}/${entry.path}`.replace(/\/{2,}/g, "/");
    const dir = fullPath.split("/").slice(0, -1).join("/") || "/";
    ensureDir(dir);
    FS.writeFile(fullPath, entry.data);
    if (i % 500 === 0 || i === total - 1) {
      onProgress?.({
        ratio: (i + 1) / total,
        path: entry.path,
        index: i,
        total,
      });
    }
  }
}
