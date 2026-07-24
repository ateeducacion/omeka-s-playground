/**
 * Pure helpers for rewriting absolute URLs in Omeka HTML responses so they
 * route through the scoped playground path (`/playground/<scope>/<runtime>/…`).
 *
 * Kept free of Service Worker globals so unit tests can import them.
 */

// Paths that live on the real static host (GitHub Pages / local dev server)
// and must NOT be forwarded to the PHP/WASM worker. Omeka's own static assets
// under `/application/asset/` are NOT listed here — they only exist inside the
// readonly core bundle in MEMFS and must be routed to the worker (via scoped
// URLs or referrer-based scoping). Adding them here made admin CSS/JS 404 on
// GitHub Pages (regression from PR #120).
export const HOST_STATIC_PREFIXES = [
  "/assets/",
  "/src/",
  "/vendor/",
  "/dist/",
  "/sw.js",
  "/remote.html",
  "/index.html",
  "/playground.config.json",
  "/favicon.ico",
];

export function isHostStaticPath(pathname) {
  const path = pathname || "/";
  return HOST_STATIC_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix),
  );
}

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const NAMED_HTML_ENTITIES = {
  amp: "&",
  quot: '"',
  apos: "'",
  sol: "/",
  colon: ":",
};

export function decodeHtmlAttributeEntities(value) {
  // Decode every entity in a single left-to-right pass. Doing it in one pass
  // (rather than chained .replace/.replaceAll calls) prevents double-unescaping:
  // a "&" produced by decoding one entity must not be reinterpreted as the
  // start of another entity in a later pass.
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (match, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (lower.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return Object.hasOwn(NAMED_HTML_ENTITIES, lower)
      ? NAMED_HTML_ENTITIES[lower]
      : match;
  });
}

/**
 * Rewrite one HTML attribute URL for a scoped Omeka response.
 *
 * @param {string} rawValue
 * @param {{
 *   origin: string,
 *   scopeId: string,
 *   runtimeId: string,
 *   appBasePath?: string,
 *   scopedBasePath?: string,
 * }} options
 *   `appBasePath` defaults to `"/"`. `scopedBasePath` defaults to
 *   `${appBasePath}/playground/${scopeId}/${runtimeId}` (with base `/` handled).
 */
export function rewriteHtmlAttributeUrl(rawValue, options) {
  const { origin, scopeId, runtimeId, appBasePath = "/" } = options;
  const scopedBasePath =
    options.scopedBasePath ??
    (appBasePath === "/"
      ? `/playground/${scopeId}/${runtimeId}`
      : `${appBasePath}/playground/${scopeId}/${runtimeId}`
    ).replace(/\/{2,}/gu, "/");

  const decodedValue = decodeHtmlAttributeEntities(rawValue);

  if (!decodedValue) {
    return decodedValue;
  }

  // Leave fragment-only, protocol-relative, and special-scheme URLs untouched.
  // Scheme matching is case-insensitive and covers every script-capable scheme
  // (javascript:, vbscript:) so none of them slip through to be rewritten.
  const lowerValue = decodedValue.toLowerCase();
  if (
    decodedValue.startsWith("#") ||
    decodedValue.startsWith("//") ||
    lowerValue.startsWith("javascript:") ||
    lowerValue.startsWith("vbscript:") ||
    lowerValue.startsWith("data:") ||
    lowerValue.startsWith("mailto:") ||
    lowerValue.startsWith("tel:")
  ) {
    return decodedValue;
  }

  // Skip relative URLs (not starting with "/") — they resolve correctly
  // relative to the document's own URL and must not be rewritten.
  if (!decodedValue.startsWith("/")) {
    return decodedValue;
  }

  try {
    const absolute = new URL(decodedValue, origin);
    if (absolute.origin !== origin) {
      return decodedValue;
    }

    const absolutePath = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    // Already under the scoped runtime path — leave alone.
    if (
      absolute.pathname.startsWith(`${scopedBasePath}/`) ||
      absolute.pathname === scopedBasePath
    ) {
      return absolutePath;
    }

    // Strip the GitHub Pages / static-hosting app base (e.g. `/omeka-s-playground`)
    // so we can decide whether this is a shell static asset or an Omeka path.
    // Omeka's AssetUrl helper prefixes Laminas basePath(), so on GH Pages it
    // emits `/omeka-s-playground/application/asset/...` rather than bare
    // `/application/asset/...`. Those still need the playground scope so the
    // worker can serve them from MEMFS — they must not be left as host-static.
    let pathFromAppRoot = absolute.pathname;
    if (
      appBasePath !== "/" &&
      (pathFromAppRoot === appBasePath ||
        pathFromAppRoot.startsWith(`${appBasePath}/`))
    ) {
      pathFromAppRoot =
        pathFromAppRoot === appBasePath
          ? "/"
          : pathFromAppRoot.slice(appBasePath.length) || "/";
    }

    // Shell/static assets on the real origin stay unscoped (samples, dist,
    // source modules, etc.).
    if (isHostStaticPath(pathFromAppRoot)) {
      return absolutePath;
    }

    if (!pathFromAppRoot.startsWith("/")) {
      return decodedValue;
    }

    return `${scopedBasePath}${pathFromAppRoot}${absolute.search}${absolute.hash}`.replace(
      /\/{2,}/gu,
      "/",
    );
  } catch {
    return decodedValue;
  }
}

export function rewriteHtmlDocument(html, scope) {
  return html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    // rewriteHtmlAttributeUrl returns a *decoded* URL (entities turned back
    // into raw &, ", <, > characters). Re-encode it for HTML attribute context
    // before interpolating it back between the quotes, otherwise a decoded
    // value containing a quote could close the attribute early and inject HTML
    // into the playground iframe (reflected XSS).
    (match, prefix, rawValue, suffix) =>
      `${prefix}${escapeHtml(rewriteHtmlAttributeUrl(rawValue, scope))}${suffix}`,
  );
}
