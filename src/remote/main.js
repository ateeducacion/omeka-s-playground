import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { buildScopedSitePath } from "../shared/paths.js";
import { createPhpBridgeChannel, createShellChannel } from "../shared/protocol.js";
import { saveSessionState } from "../shared/storage.js";

const statusEl = document.querySelector("#remote-status");
const frameEl = document.querySelector("#remote-frame");
let phpWorker;

function emit(scopeId, message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

async function registerRuntimeServiceWorker(scopeId, runtimeId, config) {
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  swUrl.searchParams.set("v", config.bundleVersion);
  swUrl.searchParams.set("scope", scopeId);
  swUrl.searchParams.set("runtime", runtimeId);

  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });

  await navigator.serviceWorker.ready;
  return registration;
}

async function waitForServiceWorkerControl() {
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    });
  }
}

async function waitForPhpWorkerReady(scopeId, runtimeId) {
  const bridge = new BroadcastChannel(createPhpBridgeChannel(scopeId));

  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      bridge.close();
      reject(new Error(`Timed out while waiting for php-worker readiness for ${runtimeId}.`));
    }, 15000);

    bridge.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.kind !== "worker-ready") {
        return;
      }

      if (message.scopeId !== scopeId || message.runtimeId !== runtimeId) {
        return;
      }

      window.clearTimeout(timeoutId);
      bridge.close();
      resolve();
    });
  });
}

async function bootstrapRemote() {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  const requestedRuntimeId = url.searchParams.get("runtime");
  const requestedPath = url.searchParams.get("path") || "/";
  const config = await loadPlaygroundConfig();
  const runtime = config.runtimes.find((entry) => entry.id === requestedRuntimeId) || getDefaultRuntime(config);

  statusEl.textContent = "Registering the Service Worker and bootstrapping the PHP CGI worker.";
  emit(scopeId, {
    kind: "progress",
    title: "Preparing runtime",
    detail: `Registering service worker for ${runtime.label}.`,
    progress: 0.08,
  });

  await registerRuntimeServiceWorker(scopeId, runtime.id, config);
  await waitForServiceWorkerControl();

  if (!phpWorker) {
    const workerUrl = new URL("../../php-worker.js", import.meta.url);
    workerUrl.searchParams.set("scope", scopeId);
    workerUrl.searchParams.set("runtime", runtime.id);
    phpWorker = new Worker(workerUrl, { type: "module" });
  }
  await waitForPhpWorkerReady(scopeId, runtime.id);

  const entryUrl = new URL(buildScopedSitePath(scopeId, runtime.id, requestedPath), window.location.origin);

  saveSessionState(scopeId, {
    runtimeId: runtime.id,
    path: requestedPath,
  });

  frameEl.src = entryUrl.toString();
  statusEl.textContent = "Runtime host registered. Waiting for the PHP worker to finish bootstrap.";

  emit(scopeId, {
    kind: "progress",
    title: "Runtime host ready",
    detail: "The embedded Omeka iframe is loading.",
    progress: 0.18,
  });

  frameEl.addEventListener("load", () => {
    emit(scopeId, {
      kind: "ready",
      detail: `Iframe loaded for ${runtime.label}.`,
      path: requestedPath,
    });
  });
}

bootstrapRemote().catch((error) => {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  statusEl.textContent = String(error?.message || error);
  emit(scopeId, {
    kind: "error",
    detail: String(error?.stack || error?.message || error),
  });
});
