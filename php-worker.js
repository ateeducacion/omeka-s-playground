import { loadPlaygroundConfig } from "./src/shared/config.js";
import {
  createPhpBridgeChannel,
  createShellChannel,
} from "./src/shared/protocol.js";
import { bootstrapOmeka, PLAYGROUND_DB_PATH } from "./src/runtime/bootstrap.js";
import { executeCliCommandInRuntime } from "./src/runtime/cli-runtime.js";
import { createPhpRuntime } from "./src/runtime/php-loader.js";
import {
  isFatalWasmError,
  isSafeToReplay,
  formatErrorDetail,
  createSnapshotManager,
} from "./src/runtime/crash-recovery.js";

const workerUrl = new URL(self.location.href);
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");

let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;
let forceCleanBoot = false;

const MAX_REACTIVE_RESTARTS = 20;
const MIN_REQUESTS_BEFORE_RESTART = 10;
let requestCount = 0;
let reactiveRestartCount = 0;

let snapshot = null;

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

snapshot = createSnapshotManager({ postShell });

function respond(payload) {
  bridgeChannel.postMessage(payload);
}

function serializeResponse(response) {
  return response.arrayBuffer().then((body) => ({
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
}

function deserializeRequest(requestLike) {
  const init = {
    method: requestLike.method,
    headers: requestLike.headers,
  };

  if (!["GET", "HEAD"].includes(requestLike.method) && requestLike.body) {
    init.body = requestLike.body;
  }

  return new Request(requestLike.url, init);
}

function buildLoadingResponse(message, status = 503) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Omeka S Playground</title><body><pre>${message}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function resetRuntime(reason) {
  if (reactiveRestartCount >= MAX_REACTIVE_RESTARTS) {
    postShell({
      kind: "error",
      detail: `[runtime] restart limit reached (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}), not restarting. Reason: ${reason}`,
    });
    return false;
  }

  if (requestCount < MIN_REQUESTS_BEFORE_RESTART) {
    postShell({
      kind: "error",
      detail: `[runtime] crash after only ${requestCount} requests (minimum ${MIN_REQUESTS_BEFORE_RESTART}), likely a fundamental bug — not restarting. Reason: ${reason}`,
    });
    return false;
  }

  reactiveRestartCount += 1;
  requestCount = 0;
  runtimeStatePromise = null;

  postShell({
    kind: "progress",
    title: "Runtime rotation",
    detail: `[runtime] restart (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}): ${reason}`,
    progress: 0.01,
  });

  return true;
}

async function getRuntimeState() {
  if (runtimeStatePromise) {
    return runtimeStatePromise;
  }

  runtimeStatePromise = (async () => {
    const config = await loadPlaygroundConfig();
    const runtime =
      config.runtimes.find((entry) => entry.id === runtimeId) ||
      config.runtimes[0];
    const appBaseUrl =
      typeof __APP_ROOT__ !== "undefined"
        ? __APP_ROOT__
        : new URL("./", self.location.href).toString();
    let stateRef = null;
    const cliExecutor = async (commandSpec, spawnOptions) =>
      executeCliCommandInRuntime({
        appBaseUrl,
        blueprint: activeBlueprint,
        commandSpec,
        config,
        mainPhp: stateRef.php,
        runtime,
        runtimeId,
        spawnOptions,
      });
    const php = createPhpRuntime(runtime, {
      appBaseUrl,
      phpVersion: runtime.phpVersion || runtime.phpVersionLabel,
      phpCorsProxyUrl: config.phpCorsProxyUrl || null,
      cliExecutor,
    });

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `Booting ${runtime.label}.`,
      progress: 0.12,
    });

    await php.refresh();
    stateRef = { appBaseUrl, config, php, runtime };

    // Restore saved snapshot if recovering from a crash
    if (snapshot.hasPendingRestore) {
      const restoreResult = await snapshot.restore(php);
      if (restoreResult?.restored) {
        postShell({
          kind: "trace",
          detail: "[snapshot] restored state onto fresh runtime",
        });
      }
    }

    const publish = (detail, progress) => {
      postShell({
        kind: "progress",
        title: "Bootstrapping Omeka",
        detail,
        progress,
      });
    };

    let bootstrapState;
    try {
      bootstrapState = await bootstrapOmeka({
        config,
        blueprint: activeBlueprint,
        clean: forceCleanBoot,
        php,
        publish,
        runtimeId,
      });
    } catch (error) {
      runtimeStatePromise = null;
      throw error;
    }

    postShell({
      kind: "ready",
      detail: `Omeka bootstrapped for ${runtime.label}.`,
      path:
        bootstrapState.readyPath ||
        activeBlueprint?.landingPage ||
        config.landingPath,
    });

    return stateRef;
  })();

  return runtimeStatePromise;
}

async function executePhpRequest(state, serializedRequest) {
  return state.php.request(deserializeRequest(serializedRequest));
}

async function respondError(id, message, status) {
  const response = buildLoadingResponse(message, status);
  respond({
    kind: "http-response",
    id,
    response: await serializeResponse(response),
  });
}

function installBridgeListener() {
  bridgeChannel.addEventListener("message", (event) => {
    const data = event.data;

    if (data?.kind !== "http-request") {
      return;
    }

    requestQueue = requestQueue.then(async () => {
      const isRetry = Boolean(data._retried);

      try {
        requestCount += 1;
        const state = await getRuntimeState();
        const response = await executePhpRequest(state, data.request);
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        if (!isFatalWasmError(error)) {
          const detail = formatErrorDetail(error);
          await respondError(data.id, detail, 500);
          postShell({ kind: "error", detail });
          return;
        }

        // --- Fatal WASM error path ---
        try {
          const currentState = await runtimeStatePromise;
          if (currentState?.php?._php) {
            await snapshot.hydrate(currentState.php, PLAYGROUND_DB_PATH);
          }
        } catch (hydrateErr) {
          postShell({
            kind: "error",
            detail: `[runtime] snapshot hydration failed: ${hydrateErr.message}`,
          });
        }

        const didReset = resetRuntime(`fatal WASM error: ${error.message}`);
        const canReplay = isSafeToReplay(data.request);

        if (isRetry || !canReplay || !didReset) {
          const detail = formatErrorDetail(error);
          const status = didReset || isRetry ? 503 : 500;
          const message = isRetry
            ? `Runtime crashed again on retry. Manual reload required.\n\n${detail}`
            : !canReplay
              ? `Runtime restarting after crash. Non-idempotent request was not retried.\n\n${detail}`
              : `Runtime restart limit reached.\n\n${detail}`;
          await respondError(data.id, message, status);
          return;
        }

        // Automatic retry on fresh runtime
        postShell({
          kind: "progress",
          title: "Crash recovery",
          detail: "[runtime] replaying request on fresh runtime…",
          progress: 0.02,
        });

        try {
          const freshState = await getRuntimeState();
          const retryResponse = await executePhpRequest(
            freshState,
            data.request,
          );
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(retryResponse),
          });
        } catch (retryError) {
          if (isFatalWasmError(retryError)) {
            resetRuntime(`fatal WASM error on retry: ${retryError.message}`);
          }
          const detail = formatErrorDetail(retryError);
          await respondError(
            data.id,
            `Runtime crashed again on retry. Manual reload required.\n\n${detail}`,
            503,
          );
        }
      }
    });
  });
}

async function capturePhpInfo() {
  try {
    const state = await getRuntimeState();
    const response = await state.php.run(
      "<?php ob_start(); phpinfo(); echo ob_get_clean();",
    );
    postShell({
      kind: "phpinfo",
      detail: "Captured PHP runtime diagnostics.",
      html: response.text || "",
    });
  } catch (error) {
    postShell({
      kind: "phpinfo",
      detail: `Failed to capture PHP info: ${formatErrorDetail(error)}`,
      html: `<!doctype html><meta charset="utf-8"><pre>${formatErrorDetail(error)}</pre>`,
    });
  }
}

function installMessageListener() {
  self.addEventListener("message", (event) => {
    if (event.data?.kind === "capture-phpinfo") {
      void capturePhpInfo();
      return;
    }

    if (event.data?.kind !== "configure-blueprint") {
      return;
    }

    activeBlueprint = event.data.blueprint || null;
    forceCleanBoot = event.data.clean === true;

    self.postMessage({
      kind: "worker-ready",
      scopeId,
      runtimeId,
    });
  });
}

try {
  bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  installBridgeListener();
  installMessageListener();

  respond({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });

  self.postMessage({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });
} catch (error) {
  self.postMessage({
    kind: "worker-startup-error",
    scopeId,
    runtimeId,
    detail: formatErrorDetail(error),
  });
  throw error;
}
