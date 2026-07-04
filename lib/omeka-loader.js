import {
  buildManifestFilename,
  DEFAULT_OMEKA_VERSION,
} from "../src/shared/omeka-versions.js";
import { resolveProjectUrl } from "../src/shared/paths.js";
import { unzipSync } from "fflate";

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
 * Download the core bundle (a solid `tar.zst`) with Cache API caching and
 * SHA-256 verification.
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
        headers: { "content-type": "application/zstd" },
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
 *
 * Pass `options.manifest` to reuse an already-fetched manifest (the version-aware
 * one from src/runtime/manifest.js) and skip the redundant manifest round-trip —
 * the boot path otherwise fetches the manifest JSON twice.
 */
export async function resolveBootstrapArchive(options = {}, onProgress) {
  const manifest = options.manifest ?? (await fetchManifest(options.manifestUrl));
  const bytes = await fetchBundleWithCache(manifest, onProgress);
  return { manifest, bytes };
}

/**
 * Sanitize a ZIP entry path to prevent ZIP-slip (path traversal). Normalizes
 * "\\" to "/" (Windows-built archives), strips leading slashes, and drops empty
 * and "." segments. Returns null when the entry contains a ".." segment (so the
 * caller can skip it) — without this a crafted archive could write outside the
 * target root via entries like "../../evil".
 */
export function sanitizeArchivePath(rawPath) {
  const segments = String(rawPath)
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * Stream a ZIP buffer one entry at a time using @php-wasm/stream-compression's
 * decodeZip, which inflates each entry on demand through the browser-native
 * DecompressionStream. The consumer can write each yielded entry to MEMFS and
 * drop it before the next, keeping peak memory ~one entry instead of the whole
 * decompressed tree — the difference that avoids the MEMFS OOM that fflate's
 * `unzipSync` (which materializes every entry at once) hits on large archives
 * (the ~19 MB / 9 310-file Omeka core, or heavy add-ons). On engines without
 * DecompressionStream it falls back to fflate so extraction still works.
 *
 * @param {Uint8Array} zipBytes
 * @returns {AsyncGenerator<{ name: string, isDirectory: boolean, data: Uint8Array | null }>}
 */
export async function* streamZipEntries(zipBytes) {
  if (typeof DecompressionStream !== "undefined") {
    const { decodeZip } = await import("@php-wasm/stream-compression");
    const reader = decodeZip(new Response(zipBytes).body).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const name = String(value.name);
      const isDirectory = value.type === "directory" || name.endsWith("/");
      yield {
        name,
        isDirectory,
        data: isDirectory ? null : new Uint8Array(await value.arrayBuffer()),
      };
    }
    return;
  }

  // Fallback for engines without DecompressionStream: fflate whole-archive.
  const raw = unzipSync(zipBytes);
  for (const [name, data] of Object.entries(raw)) {
    const isDirectory = name.endsWith("/") && data.byteLength === 0;
    yield { name, isDirectory, data: isDirectory ? null : data };
  }
}

// Add-on ZIPs are extracted by streaming `streamZipEntries` directly in
// src/runtime/addons.js (small archives). The readonly CORE bundle is a solid
// `tar.zst` that is streaming-decoded straight into MEMFS — see
// lib/streaming-tar-extract.js and src/runtime/vfs.js.
