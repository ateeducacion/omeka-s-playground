/**
 * Resolve a path relative to the project root. In the bundled worker,
 * __APP_ROOT__ (injected by esbuild) provides the root. Outside the
 * bundle, import.meta.url of this file (src/shared/) is two levels deep.
 */
export function resolveProjectUrl(assetPath) {
  const root =
    typeof __APP_ROOT__ !== "undefined"
      ? __APP_ROOT__
      : new URL("../../", import.meta.url).href;
  return new URL(assetPath, root);
}

export function getBasePathFromPathname(pathname = "/") {
  const segments = String(pathname || "/")
    .split("/")
    .filter(Boolean);

  if (segments.length <= 1) {
    return "/";
  }

  return `/${segments.slice(0, -1).join("/")}/`;
}

export function getBasePath() {
  return getBasePathFromPathname(window.location.pathname);
}

export function joinBasePath(basePath, path) {
  const cleanBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${cleanBase}/${cleanPath}`.replace(/\/{2,}/gu, "/");
}

export function resolveRemoteUrl(scopeId, runtimeId, path = "/") {
  const url = new URL("./remote.html", window.location.href);
  url.searchParams.set("scope", scopeId);
  url.searchParams.set("runtime", runtimeId);
  url.searchParams.set("path", path);
  return url;
}

export function hasBlueprintUrlOverride(locationLike = window.location.href) {
  const url =
    locationLike instanceof URL
      ? locationLike
      : new URL(
          String(locationLike || window.location.href),
          window.location.href,
        );

  return (
    url.searchParams.has("blueprint") || url.searchParams.has("blueprint-data")
  );
}

export function resolveAppUrl(path, locationLike) {
  const rawPath = String(path || "").trim();
  const fallbackLocation = globalThis.location?.href || "http://localhost/";
  const current =
    locationLike instanceof URL
      ? locationLike
      : new URL(String(locationLike || fallbackLocation), fallbackLocation);

  if (!rawPath) {
    return current;
  }

  try {
    return new URL(rawPath);
  } catch {
    // Fall through to app-relative resolution.
  }

  const normalizedPath = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  const pathname = joinBasePath(
    getBasePathFromPathname(current.pathname),
    normalizedPath,
  );
  return new URL(pathname, current.origin);
}

function isLocalDevHostname(hostname = "") {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]"
  );
}

export function resolveConfiguredProxyUrl(config = {}, locationLike) {
  const current =
    locationLike instanceof URL
      ? locationLike
      : new URL(
          String(
            locationLike || globalThis.location?.href || "http://localhost/",
          ),
          globalThis.location?.href || "http://localhost/",
        );

  const proxyPath = String(
    config.proxyPath || config.addonProxyPath || "",
  ).trim();
  const proxyUrl = String(config.proxyUrl || config.addonProxyUrl || "").trim();

  if (isLocalDevHostname(current.hostname) && proxyPath) {
    return resolveAppUrl(proxyPath, current);
  }

  if (proxyUrl) {
    return resolveAppUrl(proxyUrl, current);
  }

  if (proxyPath) {
    return resolveAppUrl(proxyPath, current);
  }

  return null;
}

export function buildScopedSitePath(scopeId, runtimeId, path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return joinBasePath(
    getBasePath(),
    `playground/${scopeId}/${runtimeId}${normalized}`,
  ).replace(/\/{2,}/gu, "/");
}
