// Shared Cloudflare Worker for omeka-s-playground and facturascripts-playground.
// Proxies allowed URLs with CORS headers for PHP WASM networking (tcpOverFetch).
// Production: https://zip-proxy.erseco.workers.dev/
// Local development uses the same-origin proxy from scripts/dev-server.mjs.

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        {
          error: "Method not allowed. Only GET and HEAD are supported.",
        },
        405,
      );
    }

    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return jsonResponse(
        {
          error: 'Missing "url" query parameter.',
        },
        400,
      );
    }

    let parsedTargetUrl;

    try {
      parsedTargetUrl = new URL(targetUrl);
    } catch (error) {
      return jsonResponse(
        {
          error: "Invalid URL.",
          details: error.message,
        },
        400,
      );
    }

    if (
      parsedTargetUrl.protocol !== "https:" &&
      parsedTargetUrl.protocol !== "http:"
    ) {
      return jsonResponse(
        {
          error: "Invalid protocol. Only http and https are allowed.",
        },
        400,
      );
    }

    if (!isAllowedUrl(parsedTargetUrl)) {
      return jsonResponse(
        {
          error:
            "The provided URL is not allowed. Only trusted hosts and ZIP downloads are supported.",
        },
        400,
      );
    }

    try {
      const acceptHeader = isFacturaScriptsPluginPage(parsedTargetUrl)
        ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
        : looksLikeZipUrl(parsedTargetUrl)
          ? "application/zip, application/octet-stream;q=0.9, */*;q=0.8"
          : "*/*";

      const upstreamResponse = await fetch(parsedTargetUrl.toString(), {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "zip-proxy-worker",
          Accept: acceptHeader,
        },
      });

      if (!upstreamResponse.ok) {
        return jsonResponse(
          {
            error: "Upstream server returned an error.",
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
          },
          502,
        );
      }

      const headers = new Headers(upstreamResponse.headers);

      applyCorsHeaders(headers);

      headers.set(
        "Content-Type",
        headers.get("Content-Type") ||
          (looksLikeZipUrl(parsedTargetUrl)
            ? "application/zip"
            : isFacturaScriptsPluginPage(parsedTargetUrl)
              ? "text/html; charset=utf-8"
              : "application/octet-stream"),
      );

      if (
        !headers.get("Content-Disposition") &&
        looksLikeZipUrl(parsedTargetUrl)
      ) {
        headers.set(
          "Content-Disposition",
          `attachment; filename="${buildZipFilename(parsedTargetUrl)}"`,
        );
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "Failed to fetch remote resource.",
          details: error.message,
        },
        502,
      );
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers":
      "Content-Disposition, Content-Type, Content-Length, X-Playground-Cors-Proxy",
    "X-Playground-Cors-Proxy": "true",
    "Access-Control-Max-Age": "86400",
  };
}

function applyCorsHeaders(headers) {
  const cors = corsHeaders();

  Object.entries(cors).forEach(([key, value]) => {
    headers.set(key, value);
  });
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

/**
 * Trusted hosts and URL patterns allowed by the proxy.
 * Combines hosts from omeka-s-playground and facturascripts-playground.
 */
function isAllowedUrl(url) {
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  // ZIP download patterns (any host).
  if (pathname.endsWith(".zip")) return true;
  if (pathname.includes("/zip/")) return true;
  if (pathname.includes("archive/refs/heads/")) return true;
  if (pathname.includes("archive/refs/tags/")) return true;

  // GitHub.
  if (hostname === "github.com") return true;
  if (hostname === "codeload.github.com") return true;
  if (hostname === "objects.githubusercontent.com") return true;
  if (hostname === "raw.githubusercontent.com") return true;
  if (hostname === "api.github.com") return true;

  // GitLab.
  if (hostname === "gitlab.com") return true;

  // jsDelivr CDN and API.
  if (hostname === "cdn.jsdelivr.net") return true;
  if (hostname === "data.jsdelivr.com") return true;

  // Omeka addon catalog.
  if (hostname === "omeka.org") return true;

  // FacturaScripts.
  if (hostname === "facturascripts.com") return true;

  // FacturaScripts plugin page (HTML scraping).
  if (isFacturaScriptsPluginPage(url)) return true;

  // FacturaScripts build downloads.
  if (/\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)) return true;

  return false;
}

function looksLikeZipUrl(url) {
  const pathname = url.pathname.toLowerCase();

  if (pathname.endsWith(".zip")) return true;
  if (pathname.includes("/zip/")) return true;
  if (pathname.includes("archive/refs/heads/")) return true;
  if (pathname.includes("archive/refs/tags/")) return true;
  if (/\/downloadbuild\/\d+\/(stable|beta)$/u.test(pathname)) return true;

  return false;
}

function isFacturaScriptsPluginPage(url) {
  return (
    url.hostname.toLowerCase() === "facturascripts.com" &&
    /^\/plugins\/[^/]+\/?$/u.test(url.pathname)
  );
}

function buildZipFilename(url) {
  const pathnameParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathnameParts[pathnameParts.length - 1] || "download.zip";

  if (lastPart.toLowerCase().endsWith(".zip")) {
    return sanitizeFilename(lastPart);
  }

  return sanitizeFilename(`${lastPart}.zip`);
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}
