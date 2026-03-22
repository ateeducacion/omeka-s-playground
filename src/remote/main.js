import { loadActiveBlueprint } from "../shared/blueprint.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { buildScopedSitePath } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import { saveSessionState } from "../shared/storage.js";

const overlayEl = document.querySelector(".remote-boot__card");
const statusEl = document.querySelector("#remote-status");
const frameEl = document.querySelector("#remote-frame");
const progressFillEl = document.querySelector("#progress-fill");
const progressPercentEl = document.querySelector("#progress-percent");
let phpWorker;
let _activeScopeId;
let _activeRuntimeId;
let activePath = "/";
let forceCleanBoot = false;

function setOverlayVisible(isVisible) {
  overlayEl?.classList.toggle("is-hidden", !isVisible);
}

function setRemoteProgress(detail, progress = null) {
  if (statusEl && detail) {
    statusEl.textContent = detail;
  }
  if (progress != null) {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (progressFillEl) {
      progressFillEl.style.width = `${pct}%`;
    }
    if (progressPercentEl) {
      progressPercentEl.textContent = `${pct}%`;
    }
  }
}

function emit(scopeId, message) {
  if (message?.kind === "progress") {
    setRemoteProgress(message.detail, message.progress);
  }
  if (message?.kind === "error") {
    setRemoteProgress(message.detail);
  }

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
      navigator.serviceWorker.addEventListener("controllerchange", resolve, {
        once: true,
      });
    });
  }
}

async function waitForPhpWorkerReady(scopeId, runtimeId, worker) {
  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          `Timed out while waiting for php-worker readiness for ${runtimeId}.`,
        ),
      );
    }, 30000);

    const onWorkerMessage = (event) => {
      const message = event.data;

      if (message?.kind === "worker-startup-error") {
        window.clearTimeout(timeoutId);
        worker.removeEventListener("message", onWorkerMessage);
        reject(
          new Error(message.detail || "php-worker failed during startup."),
        );
        return;
      }

      if (message?.kind !== "worker-ready") {
        return;
      }

      if (message.scopeId !== scopeId || message.runtimeId !== runtimeId) {
        return;
      }

      window.clearTimeout(timeoutId);
      worker.removeEventListener("message", onWorkerMessage);
      resolve();
    };

    worker.addEventListener("message", onWorkerMessage);
  });
}

function extractUnscopedPath(locationLike, scopeId, runtimeId) {
  const url = new URL(String(locationLike), window.location.origin);
  const match = url.pathname.match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (match && match[1] === scopeId && match[2] === runtimeId) {
    return `${match[3] || "/"}${url.search}${url.hash}`;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function emitNavigation(scopeId, runtimeId, href) {
  emit(scopeId, {
    kind: "navigate",
    path: extractUnscopedPath(href, scopeId, runtimeId),
  });
}

function buildEntryUrl(scopeId, runtimeId, path) {
  return new URL(
    buildScopedSitePath(scopeId, runtimeId, path),
    window.location.origin,
  );
}

function navigateFrame(scopeId, runtimeId, path, { reload = false } = {}) {
  const entryUrl = buildEntryUrl(scopeId, runtimeId, path);
  activePath = path;

  if (reload && frameEl.contentWindow) {
    frameEl.contentWindow.location.reload();
    return;
  }

  if (frameEl.src !== entryUrl.toString()) {
    frameEl.src = entryUrl.toString();
  } else if (frameEl.contentWindow) {
    frameEl.contentWindow.location.href = entryUrl.toString();
  }
}

function bindFrameNavigation(scopeId, runtimeId) {
  frameEl.addEventListener("load", () => {
    let path = activePath;
    try {
      if (frameEl.contentWindow?.location?.href) {
        path = extractUnscopedPath(
          frameEl.contentWindow.location.href,
          scopeId,
          runtimeId,
        );
      }
    } catch {
      // Ignore transient about:blank/cross-context timing during iframe swaps.
    }

    activePath = path;
    setOverlayVisible(false);
    emit(scopeId, {
      kind: "ready",
      detail: `Iframe loaded for ${runtimeId}.`,
      path,
    });
    emitNavigation(
      scopeId,
      runtimeId,
      frameEl.contentWindow?.location?.href ||
        buildEntryUrl(scopeId, runtimeId, path).toString(),
    );
  });
}

function bindShellCommands(scopeId, runtimeId) {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (message?.kind === "navigate-site") {
      navigateFrame(scopeId, runtimeId, message.path || "/");
      return;
    }

    if (message?.kind === "refresh-site") {
      navigateFrame(scopeId, runtimeId, activePath || "/", { reload: true });
      return;
    }

    if (message?.kind === "capture-phpinfo" && phpWorker) {
      phpWorker.postMessage({ kind: "capture-phpinfo" });
    }
  });
}

async function bootstrapRemote() {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  const requestedRuntimeId = url.searchParams.get("runtime");
  const requestedPath = url.searchParams.get("path") || "/";
  forceCleanBoot = url.searchParams.get("clean") === "1";
  _activeScopeId = scopeId;
  _activeRuntimeId = requestedRuntimeId;
  activePath = requestedPath;
  const config = await loadPlaygroundConfig();
  const blueprint = loadActiveBlueprint(scopeId);
  const runtime =
    config.runtimes.find((entry) => entry.id === requestedRuntimeId) ||
    getDefaultRuntime(config);
  setOverlayVisible(true);

  setRemoteProgress(
    "Registering the Service Worker and bootstrapping the PHP CGI worker.",
    0.08,
  );
  emit(scopeId, {
    kind: "progress",
    title: "Preparing runtime",
    detail: `Registering service worker for ${runtime.label}.`,
    progress: 0.08,
  });

  await registerRuntimeServiceWorker(scopeId, runtime.id, config);
  await waitForServiceWorkerControl();
  setRemoteProgress("Service Worker ready and controlling this tab.", 0.12);

  if (!phpWorker) {
    const workerUrl = new URL(
      "../../dist/php-worker.bundle.js",
      import.meta.url,
    );
    workerUrl.searchParams.set("scope", scopeId);
    workerUrl.searchParams.set("runtime", runtime.id);
    phpWorker = new Worker(workerUrl, { type: "module" });
    phpWorker.addEventListener("error", (event) => {
      const parts = [
        event.message || "php-worker failed before signalling readiness.",
        event.filename ? `file=${event.filename}` : "",
        event.lineno ? `line=${event.lineno}` : "",
      ].filter(Boolean);
      const detail = parts.join(" | ");
      setRemoteProgress(detail);
      emit(scopeId, { kind: "error", detail });
    });
  }

  // Listen to bootstrap progress from the worker via the shell channel
  // so the loading overlay shows real-time status.
  let readyNavigated = false;
  const shellChannel = new BroadcastChannel(createShellChannel(scopeId));
  shellChannel.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.kind === "progress") {
      setRemoteProgress(msg.detail, msg.progress);
    }
    if (msg?.kind === "error") {
      setRemoteProgress(msg.detail);
    }
    if (msg?.kind === "ready") {
      setRemoteProgress(msg.detail, 1);
      if (msg.path && msg.path !== activePath) {
        activePath = msg.path;
        readyNavigated = true;
        navigateFrame(scopeId, runtime.id, activePath);
      }
    }
  });

  const workerReadyPromise = waitForPhpWorkerReady(
    scopeId,
    runtime.id,
    phpWorker,
  );
  phpWorker.postMessage({
    kind: "configure-blueprint",
    blueprint,
    clean: forceCleanBoot,
  });
  await workerReadyPromise;
  setRemoteProgress(`php-worker ready for ${runtime.id}.`, 0.16);

  saveSessionState(scopeId, {
    runtimeId: runtime.id,
    path: requestedPath,
  });

  bindShellCommands(scopeId, runtime.id);
  bindFrameNavigation(scopeId, runtime.id);
  if (!readyNavigated) {
    navigateFrame(scopeId, runtime.id, activePath);
  }
}

bootstrapRemote().catch((error) => {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  setOverlayVisible(true);
  setRemoteProgress(String(error?.message || error));
  emit(scopeId, {
    kind: "error",
    detail: String(error?.stack || error?.message || error),
  });
});
