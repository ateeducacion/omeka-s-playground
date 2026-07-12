#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || process.argv[2] || 8080);
const proxyPath = "/__addon_proxy__";
const MAX_REDIRECTS = 10;
const MAX_BODY_BYTES = 52_428_800;

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

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
];

const BLOCKED_IPV6_CIDRS = [
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["ff00::", 8],
];

const ipv4BlockList = new BlockList();
const ipv6BlockList = new BlockList();

for (const [address, prefix] of BLOCKED_IPV4_CIDRS) {
  ipv4BlockList.addSubnet(address, prefix, "ipv4");
  ipv6BlockList.addSubnet(`::ffff:${address}`, 96 + prefix, "ipv6");
  ipv6BlockList.addSubnet(`::${address}`, 96 + prefix, "ipv6");
}
for (const [address, prefix] of BLOCKED_IPV6_CIDRS) {
  ipv6BlockList.addSubnet(address, prefix, "ipv6");
}
ipv6BlockList.addAddress("::", "ipv6");
ipv6BlockList.addAddress("::1", "ipv6");

export class ProxyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxyValidationError";
  }
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function normalizeHostname(hostname) {
  const value = String(hostname || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

export function addressIsBlocked(address, family = isIP(address)) {
  try {
    if (family === 4) {
      return ipv4BlockList.check(address, "ipv4");
    }
    if (family === 6) {
      return ipv6BlockList.check(address, "ipv6");
    }
  } catch {
    return true;
  }
  return true;
}

// Resolve once, reject every non-public result, and return the validated
// addresses so the transport can pin the request to the same DNS answer.
export async function resolvePublicHost(hostname, lookupFn = lookup) {
  const normalizedHostname = normalizeHostname(hostname);
  const literalFamily = isIP(normalizedHostname);
  let results;

  if (literalFamily) {
    results = [{ address: normalizedHostname, family: literalFamily }];
  } else {
    try {
      results = await lookupFn(normalizedHostname, { all: true });
    } catch {
      throw new ProxyValidationError("target host could not be validated");
    }
  }

  if (!results.length) {
    throw new ProxyValidationError("target host did not resolve");
  }
  for (const { address, family } of results) {
    if (addressIsBlocked(address, family)) {
      throw new ProxyValidationError("target host is not allowed");
    }
  }
  return results;
}

function responseHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function requestPinnedAddress(url, resolvedAddress) {
  return new Promise((resolveRequest, rejectRequest) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(
      url,
      {
        headers: { "user-agent": "omeka-s-playground-dev-server" },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [resolvedAddress]);
          } else {
            callback(null, resolvedAddress.address, resolvedAddress.family);
          }
        },
        timeout: 60_000,
      },
      (response) => {
        const status = response.statusCode || 0;
        const headers = responseHeaders(response.headers);
        const location = headers.get("location");

        if (status >= 300 && status < 400 && location) {
          response.resume();
          resolveRequest({ body: Buffer.alloc(0), headers, status });
          return;
        }

        const contentLength = Number(headers.get("content-length") || 0);
        if (contentLength > MAX_BODY_BYTES) {
          response.destroy(new Error("upstream response is too large"));
          return;
        }

        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy(new Error("upstream response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolveRequest({ body: Buffer.concat(chunks), headers, status });
        });
        response.on("error", rejectRequest);
      },
    );

    request.on("timeout", () => request.destroy(new Error("upstream timeout")));
    request.on("error", rejectRequest);
    request.end();
  });
}

async function requestWithNode(url, resolvedAddresses) {
  let lastError;
  for (const resolvedAddress of resolvedAddresses) {
    try {
      return await requestPinnedAddress(url, resolvedAddress);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("upstream request failed");
}

function curlResolveArgument(url, resolvedAddress) {
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname)) return null;
  const portNumber = url.port || (url.protocol === "https:" ? "443" : "80");
  const address =
    resolvedAddress.family === 6
      ? `[${resolvedAddress.address}]`
      : resolvedAddress.address;
  return `${hostname}:${portNumber}:${address}`;
}

async function requestPinnedAddressWithCurl(url, resolvedAddress) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "omeka-addon-proxy-"));
  const bodyPath = join(tempDirectory, "body");
  const resolveArgument = curlResolveArgument(url, resolvedAddress);
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    "60",
    "--max-filesize",
    String(MAX_BODY_BYTES),
    "--proto",
    "=http,https",
    "--noproxy",
    "*",
    "--output",
    bodyPath,
    "--write-out",
    "%{http_code}\n%{redirect_url}",
  ];
  if (resolveArgument) args.push("--resolve", resolveArgument);
  args.push(url.toString());

  try {
    const metadata = await new Promise((resolveCurl, rejectCurl) => {
      execFile(
        "curl",
        args,
        { encoding: "utf8", maxBuffer: 65_536 },
        (error, stdout) => {
          if (error) rejectCurl(new Error(`curl failed: ${error.message}`));
          else resolveCurl(stdout);
        },
      );
    });
    const [statusLine, ...redirectLines] = String(metadata).split("\n");
    const status = Number.parseInt(statusLine, 10);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("curl returned an invalid HTTP status");
    }
    return {
      body: await readFile(bodyPath),
      headers: new Headers({ location: redirectLines.join("\n").trim() }),
      status,
    };
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

async function requestWithCurl(url, resolvedAddresses) {
  let lastError;
  for (const resolvedAddress of resolvedAddresses) {
    try {
      return await requestPinnedAddressWithCurl(url, resolvedAddress);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("curl request failed");
}

export async function requestWithValidatedRedirects(
  initialUrl,
  requestSingleHop,
  resolveHost = resolvePublicHost,
) {
  let current = new URL(initialUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new ProxyValidationError("redirect to unsupported protocol");
    }

    const resolvedAddresses = await resolveHost(current.hostname);
    const response = await requestSingleHop(current, resolvedAddresses);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      try {
        current = new URL(location, current);
      } catch {
        throw new ProxyValidationError("redirect URL is invalid");
      }
      continue;
    }
    return response;
  }

  throw new ProxyValidationError("too many redirects");
}

export async function requestWithNodeRedirects(
  target,
  resolveHost = resolvePublicHost,
) {
  return requestWithValidatedRedirects(target, requestWithNode, resolveHost);
}

export async function requestWithCurlRedirects(
  target,
  resolveHost = resolvePublicHost,
) {
  return requestWithValidatedRedirects(target, requestWithCurl, resolveHost);
}

export async function fetchAddon(
  target,
  {
    nodeRequest = requestWithNodeRedirects,
    curlRequest = requestWithCurlRedirects,
  } = {},
) {
  let upstream;
  try {
    upstream = await nodeRequest(target);
  } catch (error) {
    if (error instanceof ProxyValidationError) throw error;
  }

  if (upstream?.status >= 200 && upstream.status < 300) {
    return upstream;
  }

  // Curl is used only as a transport fallback. It shares the same host,
  // redirect, protocol, and DNS-pinning policy as the primary Node request.
  return curlRequest(target);
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

  log(`proxy ${target.toString()}`);

  let upstream;
  try {
    upstream = await fetchAddon(target);
  } catch (error) {
    if (error instanceof ProxyValidationError) {
      send(res, 403, "Target host is not allowed", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }

    log(`proxy error: ${String(error?.message || error)}`);
    send(res, 502, "Upstream fetch failed", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    send(res, 502, "Upstream fetch failed", {
      "content-type": "text/plain; charset=utf-8",
    });
    return;
  }

  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type":
      upstream.headers.get("content-type") || "application/octet-stream",
    "content-length": String(upstream.body.length),
  };
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) {
    headers["content-disposition"] = disposition;
  }

  send(res, 200, upstream.body, headers);
}

export function createDevServer() {
  return createServer(async (req, res) => {
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
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const server = createDevServer();
  server.listen(port, "127.0.0.1", () => {
    log(`Omeka playground dev server listening on http://127.0.0.1:${port}`);
    log(
      `Addon proxy available at http://127.0.0.1:${port}${proxyPath}?url=<encoded-url>`,
    );
  });
}
