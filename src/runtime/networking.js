import { resolveConfiguredProxyUrl } from "../shared/paths.js";

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMethod(value) {
  return String(value || "").trim().toUpperCase();
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAllowedHost(hostname, allowedHosts) {
  const normalizedHost = normalizeHost(hostname);
  if (!normalizedHost) {
    return false;
  }

  return allowedHosts.some((entry) => {
    const normalizedEntry = normalizeHost(entry);
    return normalizedEntry
      && (normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`));
  });
}

function isConfiguredProxyUrl(url, config) {
  const proxyUrl = resolveConfiguredProxyUrl(config, globalThis.location?.href);
  return Boolean(
    proxyUrl
    && url.origin === proxyUrl.origin
    && url.pathname === proxyUrl.pathname,
  );
}

function shouldBypassPolicy(url, config) {
  return !["http:", "https:"].includes(url.protocol)
    || (globalThis.location && url.origin === globalThis.location.origin)
    || isConfiguredProxyUrl(url, config);
}

function rebuildResponse(response, bytes) {
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function buildProxiedUrl(targetUrl, config) {
  const proxied = resolveConfiguredProxyUrl(config, globalThis.location?.href);
  if (!proxied) {
    return targetUrl;
  }
  proxied.searchParams.set("url", targetUrl.toString());
  return proxied;
}

async function buildRequestInit(request) {
  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "follow",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.clone().arrayBuffer();
  }

  return init;
}

async function enforceMaxBytes(response, maxBytes) {
  if (!(maxBytes > 0)) {
    return response;
  }

  const cloned = response.clone();
  const contentLength = Number(cloned.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Outbound response exceeds the configured ${maxBytes} byte limit.`);
  }

  const bytes = await cloned.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Outbound response exceeds the configured ${maxBytes} byte limit.`);
  }

  return rebuildResponse(response, bytes);
}

export function normalizeOutboundHttpConfig(config) {
  const raw = config?.outboundHttp || {};
  const enabled = raw.enabled !== false;
  const allowedHosts = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts.map(normalizeHost).filter(Boolean)
    : [];
  const allowedMethods = Array.isArray(raw.allowedMethods) && raw.allowedMethods.length > 0
    ? raw.allowedMethods.map(normalizeMethod).filter(Boolean)
    : ["GET", "HEAD"];

  return {
    enabled,
    allowedHosts,
    allowedMethods,
    proxyPath: String(raw.proxyPath || config?.addonProxyPath || "").trim(),
    proxyUrl: String(raw.proxyUrl || config?.addonProxyUrl || "").trim(),
    proxyAllCrossOrigin: raw.proxyAllCrossOrigin !== false,
    timeoutMs: parsePositiveNumber(raw.timeoutMs, 15_000),
    maxBytes: parsePositiveNumber(raw.maxBytes, 1_048_576),
    probeUrl: String(raw.probeUrl || "").trim(),
    timeoutSeconds: parsePositiveNumber(raw.timeoutMs, 15_000) / 1000,
  };
}

export function installOutboundFetchPolicy(config) {
  if (typeof globalThis.fetch !== "function") {
    return normalizeOutboundHttpConfig(config);
  }

  const normalized = normalizeOutboundHttpConfig(config);
  const policyKey = JSON.stringify(normalized);
  const originalFetch = globalThis.__omekaOriginalFetch || globalThis.fetch.bind(globalThis);

  if (!globalThis.__omekaOriginalFetch) {
    globalThis.__omekaOriginalFetch = originalFetch;
  }

  if (globalThis.__omekaOutboundFetchPolicyKey === policyKey) {
    return normalized;
  }

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url, globalThis.location?.href);

    if (shouldBypassPolicy(url, normalized)) {
      return originalFetch(input, init);
    }

    if (!normalized.enabled) {
      throw new Error(`Outbound HTTP is disabled for ${url.hostname}.`);
    }

    if (!isAllowedHost(url.hostname, normalized.allowedHosts)) {
      throw new Error(`Outbound HTTP host "${url.hostname}" is not allowed.`);
    }

    const method = normalizeMethod(request.method || "GET");
    if (!normalized.allowedMethods.includes(method)) {
      throw new Error(`Outbound HTTP method "${method}" is not allowed for ${url.hostname}.`);
    }

    const targetUrl = normalized.proxyAllCrossOrigin
      ? buildProxiedUrl(url, normalized)
      : url;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(`Timed out after ${normalized.timeoutMs}ms.`), normalized.timeoutMs);

    try {
      const response = await originalFetch(targetUrl, {
        ...(await buildRequestInit(request)),
        signal: controller.signal,
      });
      return await enforceMaxBytes(response, normalized.maxBytes);
    } finally {
      clearTimeout(timeout);
    }
  };

  globalThis.__omekaOutboundFetchPolicyKey = policyKey;
  globalThis.__omekaOutboundFetchPolicy = normalized;

  return normalized;
}
