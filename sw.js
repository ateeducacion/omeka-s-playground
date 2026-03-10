import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";

const bridges = new Map();
const pending = new Map();

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

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
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

async function serializeRequest(request) {
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: ["GET", "HEAD"].includes(request.method) ? null : await request.clone().arrayBuffer(),
  };
}

function buildPhpRequest(originalRequest, forwardedUrl) {
  const init = {
    method: originalRequest.method,
    headers: new Headers(originalRequest.headers),
    redirect: "follow",
  };

  if (!["GET", "HEAD"].includes(originalRequest.method)) {
    init.body = originalRequest.body;
    init.duplex = "half";
  }

  return new Request(forwardedUrl.toString(), init);
}

function forwardToPhpWorker({ request, runtimeId, scopeId }) {
  const bridge = ensureBridge(scopeId);
  const id = createWorkerRequestId();

  return new Promise(async (resolve) => {
    const timeoutId = self.setTimeout(() => {
      pending.delete(id);
      resolve(buildErrorResponse("PHP worker bridge timed out.", 504));
    }, 180000);

    pending.set(id, { resolve, timeoutId });

    bridge.postMessage({
      kind: "http-request",
      id,
      request: await serializeRequest(request),
    });
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);

  if (!match) {
    return;
  }

  const [, scopeId, runtimeId, requestPath = "/"] = match;
  const forwardedUrl = new URL(requestPath, `${url.origin}/`);
  forwardedUrl.search = url.search;

  event.respondWith((async () => {
    await broadcastToClients({
      kind: "sw-debug",
      detail: `Intercepting ${event.request.method} ${url.pathname}`,
    });

    return forwardToPhpWorker({
      request: buildPhpRequest(event.request, forwardedUrl),
      runtimeId,
      scopeId,
    }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));
  })());
});
