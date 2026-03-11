import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapOmeka } from "./src/runtime/bootstrap.js";
import { createPhpRuntime } from "./src/runtime/php-loader.js";
import { installOutboundFetchPolicy } from "./src/runtime/networking.js";

const workerUrl = new URL(self.location.href);
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");
const bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));

let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;
let forceCleanBoot = false;

function formatErrorDetail(error) {
  if (typeof error === "string") {
    return error;
  }

  if (error?.stack) {
    return String(error.stack);
  }

  if (error?.message) {
    return String(error.message);
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

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

async function getRuntimeState() {
  if (runtimeStatePromise) {
    return runtimeStatePromise;
  }

  runtimeStatePromise = (async () => {
    const config = await loadPlaygroundConfig();
    const outboundHttp = installOutboundFetchPolicy(config);
    const runtime = config.runtimes.find((entry) => entry.id === runtimeId) || config.runtimes[0];
    const php = createPhpRuntime(runtime, {
      moduleArgs: {
        playgroundNetwork: outboundHttp,
      },
    });

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `Booting ${runtime.label}.`,
      progress: 0.12,
    });

    await php.refresh();

    const publish = (detail, progress) => {
      postShell({
        kind: "progress",
        title: "Bootstrapping Omeka",
        detail,
        progress,
      });
    };

    const bootstrapState = await bootstrapOmeka({
      config,
      blueprint: activeBlueprint,
      clean: forceCleanBoot,
      php,
      publish,
      runtimeId,
    });

    postShell({
      kind: "ready",
      detail: `Omeka bootstrapped for ${runtime.label}.`,
      path: bootstrapState.readyPath || activeBlueprint?.landingPage || config.landingPath,
    });

    return { php };
  })();

  return runtimeStatePromise;
}

bridgeChannel.addEventListener("message", (event) => {
  const data = event.data;

  if (data?.kind !== "http-request") {
    return;
  }

  requestQueue = requestQueue.then(async () => {
    try {
      const state = await getRuntimeState();
      const response = await state.php.request(deserializeRequest(data.request));
      respond({
        kind: "http-response",
        id: data.id,
        response: await serializeResponse(response),
      });
    } catch (error) {
      const detail = formatErrorDetail(error);
      respond({
        kind: "http-error",
        id: data.id,
        error: detail,
      });
      postShell({
        kind: "error",
        detail,
      });
    }
  });
});

self.addEventListener("message", (event) => {
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
