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

import {
  resolveConfiguredProxyUrl,
  resolveProjectUrl,
} from "../shared/paths.js";

export const APP_LOCATION = resolveProjectUrl("").href;

/**
 * Resolve the configured proxy URL for routing cross-origin downloads.
 */
export function resolveProxyUrl(config) {
  return resolveConfiguredProxyUrl(config, APP_LOCATION);
}
