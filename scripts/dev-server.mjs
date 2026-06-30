#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 8080);
const proxyPath = "/__addon_proxy__";

const MIME_TYPES = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".zip": "application/zip",
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

// SSRF guard for the addon proxy. The proxy fetches a caller-supplied URL, so
// resolve the host first and reject loopback / private / link-local targets to
// stop the dev server being used as a hop to internal services. Fails closed
// (anything unparseable is treated as blocked).
function ipv4IsPrivate(ip) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6IsPrivate(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("fec0")) return true; // deprecated site-local
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d).
  const embedded = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/u);
  if (embedded) return ipv4IsPrivate(embedded[1]);
  return false;
}

async function assertPublicHost(hostname) {
  const results = await lookup(hostname, { all: true });
  if (!results.length) {
    throw new Error("host did not resolve");
  }
  for (const { address, family } of results) {
    const blocked =
      family === 6 ? ipv6IsPrivate(address) : ipv4IsPrivate(address);
    if (blocked) {
      throw new Error("target host is not allowed");
    }
  }
}

// Follow redirects manually, re-validating every hop. fetch's built-in
// redirect:"follow" would let a public host 30x-redirect the proxy to an
// internal address without re-checking, so we drive the chain ourselves and run
// assertPublicHost before each request.
const MAX_REDIRECTS = 10;

async function fetchValidatingRedirects(initialUrl) {
  let current = new URL(initialUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new Error("redirect to unsupported protocol");
    }
    await assertPublicHost(current.hostname);
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "omeka-s-playground-dev-server" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function safeLocalPath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split("?")[0] || "/");
  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = normalizedPath === "/" ? "/index.html" : normalizedPath;
  const absolute = resolve(repoDir, `.${candidate}`);

  if (!absolute.startsWith(repoDir)) {
    return null;
  }

  return absolute;
}

async function serveStatic(_req, res, url) {
  const targetPath = safeLocalPath(url.pathname);
  if (!targetPath || !existsSync(targetPath)) {
    send(res, 404, "Not found", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  let resolvedPath = targetPath;
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) {
    resolvedPath = join(resolvedPath, "index.html");
  }

  let fileStats;
  try {
    fileStats = await stat(resolvedPath);
  } catch {
    send(res, 404, "Not found", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  const mime =
    MIME_TYPES[extname(resolvedPath).toLowerCase()] ||
    "application/octet-stream";
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": fileStats.size,
    "content-type": mime,
  });
  createReadStream(resolvedPath).pipe(res);
}

async function proxyAddon(_req, res, url) {
  const remoteUrl = url.searchParams.get("url") || "";
  let target;

  try {
    target = new URL(remoteUrl);
  } catch {
    send(res, 400, "Invalid url", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    send(res, 400, "Unsupported protocol", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  try {
    await assertPublicHost(target.hostname);
  } catch {
    send(res, 403, "Target host is not allowed", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  log(`proxy ${target.toString()}`);

  let upstream;
  try {
    upstream = await fetchValidatingRedirects(target);
  } catch {
    upstream = null;
  }

  // Some hosts (e.g. GitLab/Cloudflare) reject Node.js fetch via TLS
  // fingerprinting. Fall back to curl which is not fingerprinted.
  if (!upstream?.ok) {
    try {
      const bytes = await fetchWithCurl(target.toString());
      send(res, 200, bytes, {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      });
    } catch (error) {
      // Log the detail server-side; return a generic message so internal error
      // text (paths, stack/curl diagnostics) is never exposed to the client.
      log(`proxy error: ${String(error?.message || error)}`);
      send(res, 502, "Upstream fetch failed", {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    return;
  }

  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type":
      upstream.headers.get("content-type") || "application/octet-stream",
  };
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) {
    headers["content-disposition"] = disposition;
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  headers["content-length"] = String(bytes.length);
  send(res, 200, bytes, headers);
}

// Fallback path for hosts that reject Node's fetch via TLS fingerprinting. The
// initial host is already validated by assertPublicHost before this is called;
// curl still follows redirects itself (capped via --max-redirs) and does not
// re-validate each hop, an accepted residual for this loopback-only dev fallback.
function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-fsSL",
        "--max-redirs",
        "10",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--max-time",
        "60",
        "--max-filesize",
        "52428800",
        url,
      ],
      { encoding: "buffer", maxBuffer: 52_428_800 },
      (error, stdout) => {
        if (error) reject(new Error(`curl failed: ${error.message}`));
        else resolve(stdout);
      },
    );
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || `127.0.0.1:${port}`}`,
  );

  if (req.method === "GET" && url.pathname === proxyPath) {
    await proxyAddon(req, res, url);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(port, "127.0.0.1", () => {
  log(`Omeka playground dev server listening on http://127.0.0.1:${port}`);
  log(
    `Addon proxy available at http://127.0.0.1:${port}${proxyPath}?url=<encoded-url>`,
  );
});
