import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { resolveRemoteUrl } from "../shared/paths.js";
import { createShellChannel, SNAPSHOT_VERSION } from "../shared/protocol.js";
import { clearScopeSession, getOrCreateScopeId, loadSessionState, saveSessionState } from "../shared/storage.js";

const els = {
  address: document.querySelector("#address-input"),
  clearLogs: document.querySelector("#clear-logs-button"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  frame: document.querySelector("#site-frame"),
  logPanel: document.querySelector("#log-panel"),
  progressBar: document.querySelector("#progress-bar"),
  progressLabel: document.querySelector("#progress-label"),
  refresh: document.querySelector("#refresh-button"),
  reset: document.querySelector("#reset-button"),
  runtime: document.querySelector("#runtime-select"),
  statusDetail: document.querySelector("#status-detail"),
  statusTitle: document.querySelector("#status-title"),
};

const scopeId = getOrCreateScopeId();
let config;
let currentRuntimeId;
let currentPath = "/";
let channel;
let serviceWorkerReady = null;
const CONTROL_RELOAD_KEY = `omeka-playground:${scopeId}:sw-controlled`;

function appendLog(message, isError = false) {
  const line = `[${new Date().toISOString()}] ${message}`;
  const span = document.createElement("span");
  span.textContent = `${line}\n`;
  if (isError) {
    span.className = "error";
  }
  els.logPanel.append(span);
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function setStatus(title, detail, progress = null) {
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;

  if (typeof progress === "number") {
    els.progressBar.value = progress;
    els.progressLabel.textContent = `${Math.round(progress * 100)}%`;
  }
}

async function ensureRuntimeServiceWorker() {
  if (!config) {
    return;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  swUrl.searchParams.set("v", config.bundleVersion);
  swUrl.searchParams.set("scope", scopeId);
  swUrl.searchParams.set("runtime", currentRuntimeId);

  await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    const alreadyReloaded = window.sessionStorage.getItem(CONTROL_RELOAD_KEY) === "1";
    if (!alreadyReloaded) {
      window.sessionStorage.setItem(CONTROL_RELOAD_KEY, "1");
      window.location.reload();
      return new Promise(() => {});
    }
  }

  window.sessionStorage.removeItem(CONTROL_RELOAD_KEY);
}

async function updateFrame() {
  if (!serviceWorkerReady) {
    serviceWorkerReady = ensureRuntimeServiceWorker();
  }

  await serviceWorkerReady;
  const url = resolveRemoteUrl(scopeId, currentRuntimeId, currentPath);
  els.frame.src = url.toString();
}

function saveState(extra = {}) {
  saveSessionState(scopeId, {
    scopeId,
    runtimeId: currentRuntimeId,
    path: currentPath,
    ...extra,
  });
}

function exportSnapshot() {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    scopeId,
    runtimeId: currentRuntimeId,
    path: currentPath,
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `omeka-playground-${scopeId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importSnapshot(file) {
  const payload = JSON.parse(await file.text());
  if (payload.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version ${payload.version}`);
  }

  currentRuntimeId = payload.runtimeId || currentRuntimeId;
  currentPath = payload.path || "/";
  els.address.value = currentPath;
  els.runtime.value = currentRuntimeId;
  saveState({ importedAt: new Date().toISOString() });
  await updateFrame();
}

function bindShellChannel() {
  channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.kind) {
      case "progress":
        setStatus(message.title, message.detail, message.progress);
        appendLog(`${message.title}: ${message.detail}`);
        break;
      case "ready":
        setStatus("Runtime ready", message.detail || "Omeka S is ready.", 1);
        currentPath = message.path || currentPath;
        els.address.value = currentPath;
        saveState({ lastReadyAt: new Date().toISOString() });
        break;
      case "navigate":
        currentPath = message.path || "/";
        els.address.value = currentPath;
        saveState();
        break;
      case "error":
        setStatus("Runtime error", message.detail, els.progressBar.value);
        appendLog(message.detail, true);
        break;
      default:
        break;
    }
  });
}

function bindServiceWorkerMessages() {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.kind === "sw-debug") {
      appendLog(`[sw] ${message.detail}`);
    }
  });
}

async function main() {
  config = await loadPlaygroundConfig();
  const previous = loadSessionState(scopeId);
  const defaultRuntime = getDefaultRuntime(config);

  currentRuntimeId = previous?.runtimeId || defaultRuntime.id;
  currentPath = previous?.path || config.landingPath || "/";
  els.address.value = currentPath;

  for (const runtime of config.runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = runtime.label;
    els.runtime.append(option);
  }
  els.runtime.value = currentRuntimeId;

  bindShellChannel();
  bindServiceWorkerMessages();
  setStatus("Booting runtime", "Loading shell and runtime configuration.", 0.04);
  await updateFrame();
}

els.refresh.addEventListener("click", () => {
  void updateFrame();
});

els.runtime.addEventListener("change", () => {
  currentRuntimeId = els.runtime.value;
  appendLog(`Switching runtime to ${currentRuntimeId}`);
  saveState({ switchedAt: new Date().toISOString() });
  serviceWorkerReady = null;
  void updateFrame();
});

els.address.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  currentPath = els.address.value || "/";
  saveState();
  void updateFrame();
});

els.reset.addEventListener("click", () => {
  clearScopeSession(scopeId);
  setStatus("Resetting playground", "Clearing local shell state. The runtime overlay reset is handled inside the remote host.", 0.02);
  serviceWorkerReady = null;
  void updateFrame();
});

els.clearLogs.addEventListener("click", () => {
  els.logPanel.textContent = "";
});

els.exportButton.addEventListener("click", exportSnapshot);

els.importInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    await importSnapshot(file);
    appendLog(`Imported shell snapshot from ${file.name}`);
  } catch (error) {
    appendLog(String(error?.message || error), true);
  } finally {
    els.importInput.value = "";
  }
});

main().catch((error) => {
  appendLog(String(error?.stack || error?.message || error), true);
  setStatus("Failed to start shell", String(error?.message || error), 0);
});
