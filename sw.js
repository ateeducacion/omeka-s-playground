import { BUILD_VERSION } from "./src/generated/build-version.js";
import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";

const INTERNAL_PROXY_PATH = "/__playground_proxy__";
// Cache-first store for the immutable, hash-named runtime assets under /dist/
// (the multi-MB PHP .wasm + intl .so). Their filenames already encode a content
// hash, so they are safe to serve from cache indefinitely and offline; the cache
// name is keyed by the worker-bundle build so `activate` can drop old
// generations. The large readonly-core ZIP under /assets/omeka/ is deliberately
// left out — the worker caches it via its own Cache API with SHA verification.
const STATIC_CACHE_NAME = `omeka-static-${BUILD_VERSION}`;
const CACHEABLE_DIST_RE = /\/dist\/[^/]+\.(?:wasm|so)$/u;
let addonProxyUrlOverride = null;
let playgroundConfigPromise;

const bridges = new Map();
const pending = new Map();
const clientContexts = new Map();
const STATIC_PREFIXES = [
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

function getAppBasePath() {
  const scopeUrl = new URL(self.registration.scope);
  const pathname = scopeUrl.pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) || "/" : pathname || "/";
}

function stripAppBasePath(pathname) {
  const basePath = getAppBasePath();
  if (basePath === "/") {
    return pathname || "/";
  }

  if (pathname === basePath) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname || "/";
}

function withAppBasePath(pathname) {
  const basePath = getAppBasePath();
  if (basePath === "/") {
    return pathname;
  }

  return `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`.replace(/\/{2,}/gu, "/");
}

function buildErrorResponse(message, status = 500) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Omeka Playground Error</title><body><pre>${message}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function isCacheableStatic(pathname) {
  return CACHEABLE_DIST_RE.test(stripAppBasePath(pathname));
}

async function cacheFirst(request) {
  let cache;
  try {
    cache = await caches.open(STATIC_CACHE_NAME);
  } catch {
    return fetch(request);
  }

  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  // Only store complete 200 responses (cache.put rejects 206 Partial Content).
  if (response.status === 200) {
    // Clone before the body is consumed by the caller.
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function loadServiceWorkerConfig() {
  if (!playgroundConfigPromise) {
    playgroundConfigPromise = fetch(
      new URL("playground.config.json", self.registration.scope),
      { cache: "no-store" },
    ).then((r) => (r.ok ? r.json() : {}));
  }
  return playgroundConfigPromise;
}

async function handleInternalProxyRequest(request, sourceUrl) {
  const config = await loadServiceWorkerConfig();
  const proxyBaseUrl = addonProxyUrlOverride || config.addonProxyUrl || "";
  if (!proxyBaseUrl) {
    return buildErrorResponse("No addon proxy configured.", 502);
  }
  const upstreamUrl = new URL(proxyBaseUrl);
  upstreamUrl.search = sourceUrl.search;
  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "follow",
  };
  init.headers.delete("host");
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.clone().arrayBuffer();
  }
  const resp = await fetch(upstreamUrl.toString(), init);
  const headers = new Headers(resp.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function ensureBridge(scopeId) {
  if (bridges.has(scopeId)) {
    return bridges.get(scopeId);
  }

  const bridge = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  bridge.addEventListener("message", (event) => {
    const message = event.data;
    if (!message?.id || !pending.has(message.id)) {
      return;
    }

    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timeoutId);

    if (message.kind === "http-response") {
      entry.resolve(new Response(message.response.body, {
        status: message.response.status,
        statusText: message.response.statusText,
        headers: message.response.headers,
      }));
      return;
    }

    entry.resolve(buildErrorResponse(message.error || "Unknown PHP worker error."));
  });

  bridges.set(scopeId, bridge);
  return bridge;
}

function extractScopedRuntime(pathname) {
  const match = stripAppBasePath(pathname).match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (!match) {
    return null;
  }

  return {
    scopeId: match[1],
    runtimeId: match[2],
    requestPath: match[3] || "/",
  };
}

async function resolveScopedRequest(event, url) {
  const strippedPathname = stripAppBasePath(url.pathname);
  const direct = extractScopedRuntime(url.pathname);
  if (direct) {
    return {
      ...direct,
      requestPath: `${direct.requestPath}${url.search}`,
    };
  }

  if (STATIC_PREFIXES.some((prefix) => strippedPathname === prefix || strippedPathname.startsWith(prefix))) {
    return null;
  }

  if (event.request.referrer) {
    const referrerUrl = new URL(event.request.referrer);
    const scopedFromReferrer = extractScopedRuntime(referrerUrl.pathname);
    if (scopedFromReferrer && referrerUrl.origin === url.origin) {
      return {
        scopeId: scopedFromReferrer.scopeId,
        runtimeId: scopedFromReferrer.runtimeId,
        requestPath: `${strippedPathname}${url.search}`,
      };
    }
  }

  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (event.clientId && clientContexts.has(event.clientId)) {
    const scoped = clientContexts.get(event.clientId);
    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
  }

  if (!client) {
    return null;
  }

  const clientUrl = new URL(client.url);
  const scoped = extractScopedRuntime(clientUrl.pathname);
  if (!scoped || clientUrl.origin !== url.origin) {
    return null;
  }

    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
}

// Build the serialized request posted to the PHP worker. The body is the
// already-buffered ArrayBuffer captured synchronously in the fetch handler (see
// the comment there): forwarding the original request's stream instead would
// throw in Firefox, which neuters event.request.body once the handler yields.
async function buildForwardedRequest(originalRequest, forwardedUrl, bufferedBody) {
  return {
    url: forwardedUrl.toString(),
    method: originalRequest.method,
    headers: Object.fromEntries(new Headers(originalRequest.headers).entries()),
    body: bufferedBody ? await bufferedBody : null,
  };
}

function rewriteScopedLocation(response, { origin, scopeId, runtimeId }) {
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const resolved = new URL(location, origin);
  if (resolved.origin !== origin) {
    return response;
  }

  const scopedPath = withAppBasePath(`/playground/${scopeId}/${runtimeId}${stripAppBasePath(resolved.pathname)}`.replace(/\/{2,}/gu, "/"));
  const headers = new Headers(response.headers);
  headers.set("location", `${scopedPath}${resolved.search}${resolved.hash}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getScopedBasePath(scopeId, runtimeId) {
  return withAppBasePath(`/playground/${scopeId}/${runtimeId}`);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlAttributeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&sol;", "/")
    .replaceAll("&colon;", ":");
}

function rewriteHtmlAttributeUrl(rawValue, { origin, scopeId, runtimeId }) {
  const decodedValue = decodeHtmlAttributeEntities(rawValue);
  const scopedBasePath = getScopedBasePath(scopeId, runtimeId);
  const appBasePath = getAppBasePath();

  if (!decodedValue) {
    return decodedValue;
  }

  if (
    decodedValue.startsWith("#")
    || decodedValue.startsWith("javascript:")
    || decodedValue.startsWith("data:")
    || decodedValue.startsWith("mailto:")
    || decodedValue.startsWith("tel:")
    || decodedValue.startsWith("//")
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
    if (absolute.pathname.startsWith(`${scopedBasePath}/`) || absolute.pathname === scopedBasePath) {
      return absolutePath;
    }

    if (appBasePath !== "/" && (absolute.pathname === appBasePath || absolute.pathname.startsWith(`${appBasePath}/`))) {
      return absolutePath;
    }

    if (!absolute.pathname.startsWith("/")) {
      return decodedValue;
    }

    return `${scopedBasePath}${absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`}`.replace(/\/{2,}/gu, "/");
  } catch {
    return decodedValue;
  }
}

function rewriteHtmlDocument(html, scope) {
  return html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    // rewriteHtmlAttributeUrl returns a *decoded* URL (entities turned back
    // into raw &, ", <, > characters). Re-encode it for HTML attribute context
    // before interpolating it back between the quotes, otherwise a decoded
    // value containing a quote could close the attribute early and inject HTML
    // into the playground iframe (reflected XSS).
    (match, prefix, rawValue, suffix) => `${prefix}${escapeHtml(rewriteHtmlAttributeUrl(rawValue, scope))}${suffix}`,
  );
}

async function rewriteScopedHtmlResponse(response, scope) {
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
    return response;
  }

  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(rewriteHtmlDocument(html, scope), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildScopedUrl(url, { scopeId, runtimeId, requestPath }) {
  const scopedPath = withAppBasePath(
    `/playground/${scopeId}/${runtimeId}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`
      .replace(/\/{2,}/gu, "/"),
  );
  return new URL(`${scopedPath}`, url.origin);
}

function forwardToPhpWorker({ serializedRequest, runtimeId, scopeId }) {
  const bridge = ensureBridge(scopeId);
  const id = createWorkerRequestId();

  return new Promise((resolve) => {
    const timeoutId = self.setTimeout(() => {
      pending.delete(id);
      resolve(buildErrorResponse("PHP worker bridge timed out.", 504));
    }, 180000);

    pending.set(id, { resolve, timeoutId });

    bridge.postMessage({
      kind: "http-request",
      id,
      request: serializedRequest,
    });
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.kind === "configure-service-worker") {
    addonProxyUrlOverride = event.data.addonProxyUrl || null;
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop static caches from older builds before claiming clients.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("omeka-static-") && name !== STATIC_CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Firefox neuters event.request.body once this handler yields to the event
  // loop, so buffer the body synchronously now — before any await — for the
  // methods that carry one. Reading it later (after the resolveScopedRequest()
  // awaits) throws in Firefox and makes the whole handler reject ("A
  // ServiceWorker intercepted the request and encountered an unexpected
  // error"), which broke every POST/PUT form submission. The buffered bytes
  // are forwarded to the PHP worker in place of the stream. Cloning leaves
  // event.request intact for the pass-through fetch() branches.
  const bufferedBody = ["GET", "HEAD"].includes(event.request.method)
    ? null
    : event.request.clone().arrayBuffer().catch(() => null);
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
      return fetch(event.request);
    }

    // Cache-first for the immutable runtime assets under /dist/ (WASM + intl .so),
    // so reloads (and offline) don't re-download tens of MB. Range requests are
    // passed through so a partial-content consumer still gets a 206.
    if (
      event.request.method === "GET" &&
      !event.request.headers.has("range") &&
      isCacheableStatic(url.pathname)
    ) {
      return cacheFirst(event.request);
    }

    const strippedPath = stripAppBasePath(url.pathname);
    if (strippedPath.split("?")[0] === INTERNAL_PROXY_PATH) {
      return handleInternalProxyRequest(event.request, url);
    }

    const scopedRequest = await resolveScopedRequest(event, url);
    if (!scopedRequest) {
      const strippedPathname = strippedPath;
      if (strippedPathname === "/jquery-3.7.1.min.js") {
        return fetch(new URL(withAppBasePath("/application/asset/vendor/jquery/jquery.min.js"), self.location.origin));
      }
      if (strippedPathname === "/css" && url.searchParams.has("family")) {
        return new Response("", {
          status: 200,
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "public, max-age=86400",
          },
        });
      }
      return fetch(event.request);
    }

    const { scopeId, runtimeId, requestPath } = scopedRequest;
    if (event.clientId) {
      clientContexts.set(event.clientId, { scopeId, runtimeId });
    }

    const directScoped = extractScopedRuntime(url.pathname);
    if (!directScoped && event.request.mode === "navigate" && event.request.method === "GET") {
      return Response.redirect(buildScopedUrl(url, scopedRequest), 302);
    }

    const forwardedUrl = new URL(requestPath, `${url.origin}/`);

    const response = await forwardToPhpWorker({
      serializedRequest: await buildForwardedRequest(event.request, forwardedUrl, bufferedBody),
      runtimeId,
      scopeId,
    }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

    const locationScopedResponse = rewriteScopedLocation(response, {
      origin: url.origin,
      scopeId,
      runtimeId,
    });
    return rewriteScopedHtmlResponse(locationScopedResponse, {
      origin: url.origin,
      scopeId,
      runtimeId,
    });
  })());
});
