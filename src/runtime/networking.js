/**
 * Networking utilities for the Omeka S Playground.
 *
 * With @php-wasm, PHP's HTTP functions (file_get_contents, curl, etc.) go
 * through the browser's fetch() API natively. No fetch wrapping or allowlist
 * is needed — the browser's standard CORS and security policies apply.
 *
 * The only utility still needed is proxy URL resolution for cross-origin
 * downloads that lack CORS headers (GitHub releases, omeka.org ZIPs, etc.).
 */

import { resolveConfiguredProxyUrl } from "../shared/paths.js";

// In the bundled worker, globalThis.location.href points to /dist/php-worker.bundle.js.
// Use __APP_ROOT__ (injected by esbuild) to get the actual project root URL.
export const APP_LOCATION =
  typeof __APP_ROOT__ !== "undefined"
    ? __APP_ROOT__
    : globalThis.location?.href ||
      globalThis.self?.location?.href ||
      "http://localhost/";

/**
 * Resolve the configured proxy URL for routing cross-origin downloads.
 */
export function resolveProxyUrl(config) {
  return resolveConfiguredProxyUrl(config, APP_LOCATION);
}
