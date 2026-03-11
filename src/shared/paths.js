export function getBasePathFromPathname(pathname = "/") {
  const segments = String(pathname || "/").split("/").filter(Boolean);

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

export function resolveAppUrl(path, locationLike) {
  const rawPath = String(path || "").trim();
  const fallbackLocation = globalThis.location?.href || "http://localhost/";
  const current = locationLike instanceof URL
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
  const pathname = joinBasePath(getBasePathFromPathname(current.pathname), normalizedPath);
  return new URL(pathname, current.origin);
}

export function buildScopedSitePath(scopeId, runtimeId, path = "/") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return joinBasePath(getBasePath(), `playground/${scopeId}/${runtimeId}${normalized}`).replace(/\/{2,}/gu, "/");
}
