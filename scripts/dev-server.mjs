#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

async function serveStatic(req, res, url) {
  const targetPath = safeLocalPath(url.pathname);
  if (!targetPath || !existsSync(targetPath)) {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
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
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  const mime = MIME_TYPES[extname(resolvedPath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-length": fileStats.size,
    "content-type": mime,
  });
  createReadStream(resolvedPath).pipe(res);
}

async function proxyAddon(req, res, url) {
  const remoteUrl = url.searchParams.get("url") || "";
  let target;

  try {
    target = new URL(remoteUrl);
  } catch {
    send(res, 400, "Invalid url", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    send(res, 400, "Unsupported protocol", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  log(`proxy ${target.toString()}`);

  let upstream;
  try {
    upstream = await fetch(target, {
      redirect: "follow",
      headers: {
        "user-agent": "omeka-s-playground-dev-server",
      },
    });
  } catch (error) {
    send(res, 502, String(error?.message || error), { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => upstream.statusText);
    send(res, upstream.status, body || upstream.statusText, {
      "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
    });
    return;
  }

  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
  };
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) {
    headers["content-disposition"] = disposition;
  }

  const bytes = Buffer.from(await upstream.arrayBuffer());
  headers["content-length"] = String(bytes.length);
  send(res, 200, bytes, headers);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${port}`}`);

  if (req.method === "GET" && url.pathname === proxyPath) {
    await proxyAddon(req, res, url);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(port, "127.0.0.1", () => {
  log(`Omeka playground dev server listening on http://127.0.0.1:${port}`);
  log(`Addon proxy available at http://127.0.0.1:${port}${proxyPath}?url=<encoded-url>`);
});
