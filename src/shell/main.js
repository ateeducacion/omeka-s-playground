import {
  buildDefaultBlueprint,
  clearActiveBlueprint,
  exportBlueprintPayload,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
  saveActiveBlueprint,
} from "../shared/blueprint.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { hasBlueprintUrlOverride, resolveRemoteUrl } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import {
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../shared/storage.js";

const els = {
  addressForm: document.querySelector("#address-form"),
  address: document.querySelector("#address-input"),
  blueprintPanel: document.querySelector("#blueprint-panel"),
  blueprintTab: document.querySelector("#blueprint-tab"),
  blueprintTextarea: document.querySelector("#blueprint-textarea"),
  clearLogs: document.querySelector("#clear-logs-button"),
  copyLogs: document.querySelector("#copy-logs-button"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  frame: document.querySelector("#site-frame"),
  logPanel: document.querySelector("#log-panel"),
  logsPanel: document.querySelector("#logs-panel"),
  logsTab: document.querySelector("#logs-tab"),
  panelToggle: document.querySelector("#panel-toggle-button"),
  phpInfoFrame: document.querySelector("#phpinfo-frame"),
  phpInfoPanel: document.querySelector("#phpinfo-panel"),
  phpInfoTab: document.querySelector("#phpinfo-tab"),
  refreshPhpInfoButton: document.querySelector("#refresh-phpinfo-button"),
  refresh: document.querySelector("#refresh-button"),
  homeButton: document.querySelector("#home-button"),
  adminButton: document.querySelector("#admin-button"),
  reset: document.querySelector("#reset-button"),
  settingsButton: document.querySelector("#settings-button"),
  settingsPopover: document.querySelector("#settings-popover"),
  settingsOverlay: document.querySelector("#settings-overlay"),
  settingsPhpVersion: document.querySelector("#settings-php-version"),
  settingsApply: document.querySelector("#settings-apply"),
  settingsCancel: document.querySelector("#settings-cancel"),
  currentOmekaLabel: document.querySelector("#current-omeka-label"),
  currentPhpLabel: document.querySelector("#current-php-label"),
  currentRuntimeLabel: document.querySelector("#current-runtime-label"),
  infoPanel: document.querySelector("#info-panel"),
  infoTab: document.querySelector("#info-tab"),
  sidePanel: document.querySelector("#side-panel"),
  workspace: document.querySelector("#workspace"),
};

const scopeId = getOrCreateScopeId();
let config;
let currentRuntimeId;
let currentPath = "/";
let channel;
let serviceWorkerReady = null;
let activeBlueprint;
let remoteFrameBooted = false;
let uiLocked = true;
const remoteReloadToken = 0;
let pendingCleanBoot = hasBlueprintUrlOverride(window.location.href);
let latestPhpInfoHtml = "";
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

function setUiLocked(locked) {
  uiLocked = locked;
  els.address.disabled = locked;
  els.homeButton.disabled = locked;
  els.adminButton.disabled = locked;
  els.refreshPhpInfoButton.disabled = locked;
  els.reset.disabled = locked;
  els.exportButton.disabled = locked;
  els.importInput.disabled = locked;
  els.addressForm.classList.toggle("is-disabled", locked);
}

async function ensureRuntimeServiceWorker() {
  if (!config) {
    return;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  swUrl.searchParams.set("v", config.bundleVersion);
  swUrl.searchParams.set("scope", scopeId);
  swUrl.searchParams.set("runtime", currentRuntimeId);

  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });
  await registration.update();
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    const alreadyReloaded =
      window.sessionStorage.getItem(CONTROL_RELOAD_KEY) === "1";
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
  if (pendingCleanBoot) {
    url.searchParams.set("clean", "1");
  }
  if (remoteReloadToken > 0) {
    url.searchParams.set("reload", String(remoteReloadToken));
  }
  remoteFrameBooted = false;
  els.frame.src = url.toString();
  pendingCleanBoot = false;
}

function postToRemote(message) {
  if (!els.frame.contentWindow) {
    return false;
  }

  els.frame.contentWindow.postMessage(message, window.location.origin);
  return true;
}

function navigateWithinRuntime(path) {
  if (uiLocked) {
    return;
  }

  currentPath = path || "/";
  els.address.value = currentPath;
  saveState();

  if (
    remoteFrameBooted &&
    postToRemote({ kind: "navigate-site", path: currentPath })
  ) {
    appendLog(`Navigating site to ${currentPath}`);
    return;
  }

  void updateFrame();
}

// biome-ignore lint/correctness/noUnusedVariables: called via postToRemote from remote.html
function refreshWithinRuntime() {
  if (remoteFrameBooted && postToRemote({ kind: "refresh-site" })) {
    appendLog(`Refreshing ${currentPath}`);
    return;
  }

  void updateFrame();
}

function navigateHome() {
  navigateWithinRuntime("/");
}

function navigateAdmin() {
  navigateWithinRuntime("/admin");
}

function setPhpInfoContent(html = "") {
  latestPhpInfoHtml = typeof html === "string" ? html : "";
  if (!els.phpInfoFrame) {
    return;
  }

  if (!latestPhpInfoHtml) {
    els.phpInfoFrame.srcdoc = `<!doctype html><meta charset="utf-8"><style>
      html,body{height:100%}
      body{margin:0;font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;color:#1f2937;background:#fff;box-sizing:border-box}
      p{margin:0}
    </style><p>No PHP diagnostics captured yet.</p>`;
    return;
  }

  const responsivePhpInfoHtml = latestPhpInfoHtml.replace(
    "</head>",
    `<style>
      html,body{height:100%}
      body{margin:0;padding:12px;box-sizing:border-box;overflow:auto;background:#fff;color:#222;font-family:sans-serif}
      .center{width:100%}
      .center table{width:100%;max-width:100%;margin:1em auto;text-align:left}
      table{border-collapse:collapse;border:0;width:100%;max-width:100%;box-shadow:0 1px 3px rgba(0,0,0,.12);table-layout:auto}
      td,th{border:1px solid #666;font-size:75%;vertical-align:baseline;padding:4px 5px}
      th{position:sticky;top:0;background:inherit}
      .e{width:28%;min-width:180px}
      .v{max-width:none;overflow-wrap:anywhere;word-break:break-word}
      hr{width:100%;max-width:100%}
      img{max-width:100%;height:auto}
      pre{white-space:pre-wrap;overflow-wrap:anywhere}
      h1,h2{scroll-margin-top:12px}
    </style></head>`,
  );

  els.phpInfoFrame.srcdoc = responsivePhpInfoHtml;
}

function requestPhpInfoCapture() {
  setActivePanel("phpinfo");
  capturePhpInfoViaWorker("manual");
}

function capturePhpInfoViaWorker(reason = "manual") {
  if (!config) {
    appendLog(
      "Cannot capture PHP info before the playground configuration is loaded.",
      true,
    );
    return;
  }

  appendLog(`Requesting PHP runtime diagnostics (${reason}).`);

  if (els.frame?.contentWindow) {
    els.frame.contentWindow.postMessage({ kind: "capture-phpinfo" }, "*");
  } else {
    appendLog("Cannot capture PHP info: remote frame not available.", true);
  }
}

function setActivePanel(panel) {
  const panels = {
    info: [els.infoPanel, els.infoTab],
    logs: [els.logsPanel, els.logsTab],
    phpinfo: [els.phpInfoPanel, els.phpInfoTab],
    blueprint: [els.blueprintPanel, els.blueprintTab],
  };

  for (const [panelName, [panelEl, tabEl]] of Object.entries(panels)) {
    const isActive = panelName === panel;
    panelEl.classList.toggle("is-hidden", !isActive);
    tabEl.classList.toggle("is-active", isActive);
    tabEl.setAttribute("aria-selected", String(isActive));
  }
}

function toggleSidePanel() {
  const collapsed = els.sidePanel.classList.toggle("is-collapsed");
  els.workspace.classList.toggle("is-panel-collapsed", collapsed);
  els.panelToggle.setAttribute("aria-expanded", String(!collapsed));
}

function saveState(extra = {}) {
  saveSessionState(scopeId, {
    scopeId,
    runtimeId: currentRuntimeId,
    path: currentPath,
    ...extra,
  });
}

function exportBlueprint() {
  const payload = exportBlueprintPayload(config, activeBlueprint);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "omeka-playground.blueprint.json";
  link.click();
  URL.revokeObjectURL(url);
}

function updateBlueprintTextarea() {
  if (!config || !activeBlueprint || !els.blueprintTextarea) {
    return;
  }

  els.blueprintTextarea.value = JSON.stringify(
    exportBlueprintPayload(config, activeBlueprint),
    null,
    2,
  );
  els.blueprintTextarea.scrollTop = 0;
}

async function importPayload(file) {
  const imported = parseImportedBlueprintPayload(
    JSON.parse(await file.text()),
    config,
  );

  if (imported.type === "snapshot") {
    currentRuntimeId = imported.runtimeId || currentRuntimeId;
    currentPath = imported.path || "/";
    els.address.value = currentPath;
    saveState({ importedAt: new Date().toISOString() });
    await updateFrame();
    return;
  }

  activeBlueprint = imported.blueprint;
  saveActiveBlueprint(scopeId, activeBlueprint);
  pendingCleanBoot = true;
  currentPath = activeBlueprint.landingPage || config.landingPath || "/";
  els.address.value = currentPath;
  updateBlueprintTextarea();
  saveState({ importedBlueprintAt: new Date().toISOString() });
  await updateFrame();
}

function bindShellChannel() {
  channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.kind) {
      case "progress":
        setUiLocked(true);
        appendLog(`${message.title}: ${message.detail}`);
        break;
      case "ready":
        remoteFrameBooted = true;
        setUiLocked(false);
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
        remoteFrameBooted = false;
        setUiLocked(false);
        appendLog(message.detail, true);
        if (!latestPhpInfoHtml) {
          capturePhpInfoViaWorker("bootstrap-error");
        }
        break;
      case "phpinfo":
        setPhpInfoContent(message.html || "");
        appendLog(message.detail || "Captured PHP runtime diagnostics.");
        break;
      case "trace":
        appendLog(message.detail || "[trace]");
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

function populateSettingsModal() {
  if (!els.settingsPhpVersion) {
    return;
  }

  els.settingsPhpVersion.innerHTML = "";
  for (const runtime of config.runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = runtime.label;
    els.settingsPhpVersion.append(option);
  }
  els.settingsPhpVersion.value = currentRuntimeId;
}

function updateCurrentVersionLabels() {
  if (els.currentOmekaLabel) {
    els.currentOmekaLabel.textContent =
      config.omekaVersion || config.bundleVersion || "-";
  }
  if (els.currentPhpLabel) {
    const runtime = config.runtimes.find((r) => r.id === currentRuntimeId);
    els.currentPhpLabel.textContent = runtime
      ? runtime.label
      : currentRuntimeId;
  }
  if (els.currentRuntimeLabel) {
    els.currentRuntimeLabel.textContent = currentRuntimeId;
  }
}

function openSettingsPopover() {
  if (!els.settingsPopover) {
    return;
  }
  populateSettingsModal();
  els.settingsPopover.classList.add("is-open");
  els.settingsOverlay.classList.add("is-open");
  els.settingsOverlay.setAttribute("aria-hidden", "false");
  els.settingsButton.setAttribute("aria-expanded", "true");
  const firstInput = els.settingsPopover.querySelector("select");
  if (firstInput) {
    firstInput.focus();
  }
}

function closeSettingsPopover() {
  if (!els.settingsPopover) {
    return;
  }
  els.settingsPopover.classList.remove("is-open");
  els.settingsOverlay.classList.remove("is-open");
  els.settingsOverlay.setAttribute("aria-hidden", "true");
  els.settingsButton.setAttribute("aria-expanded", "false");
  els.settingsButton.focus();
}

function applySettingsAndReset() {
  const newRuntimeId = els.settingsPhpVersion?.value;
  closeSettingsPopover();

  if (newRuntimeId === currentRuntimeId) {
    return;
  }

  currentRuntimeId = newRuntimeId;
  remoteFrameBooted = false;
  appendLog(`Switching runtime to ${currentRuntimeId}`);
  updateCurrentVersionLabels();
  saveState({ switchedAt: new Date().toISOString() });
  serviceWorkerReady = null;
  pendingCleanBoot = true;
  setPhpInfoContent("");
  void updateFrame();
}

async function main() {
  config = await loadPlaygroundConfig();
  activeBlueprint = await resolveBlueprintForShell(scopeId, config);
  updateBlueprintTextarea();
  const previous = loadSessionState(scopeId);
  const defaultRuntime = getDefaultRuntime(config);
  const preferredPath =
    activeBlueprint?.landingPage || config.landingPath || "/";
  const shouldForceCleanBoot = pendingCleanBoot;
  const shouldBypassSavedLogin =
    config.autologin && previous?.path === "/login";

  currentRuntimeId = shouldForceCleanBoot
    ? defaultRuntime.id
    : previous?.runtimeId || defaultRuntime.id;
  currentPath = shouldForceCleanBoot
    ? preferredPath
    : shouldBypassSavedLogin
      ? preferredPath
      : previous?.path || preferredPath;
  els.address.value = currentPath;

  updateCurrentVersionLabels();

  // Settings popover event listeners
  if (els.settingsButton) {
    els.settingsButton.addEventListener("click", () => {
      const isOpen = els.settingsPopover?.classList.contains("is-open");
      if (isOpen) {
        closeSettingsPopover();
      } else {
        openSettingsPopover();
      }
    });
  }
  if (els.settingsOverlay) {
    els.settingsOverlay.addEventListener("click", closeSettingsPopover);
  }
  if (els.settingsCancel) {
    els.settingsCancel.addEventListener("click", closeSettingsPopover);
  }
  if (els.settingsApply) {
    els.settingsApply.addEventListener("click", applySettingsAndReset);
  }

  // Close popover on Escape
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      els.settingsPopover?.classList.contains("is-open")
    ) {
      closeSettingsPopover();
    }
  });

  bindShellChannel();
  bindServiceWorkerMessages();
  setPhpInfoContent("");
  setUiLocked(true);
  await updateFrame();
}

els.refresh.addEventListener("click", () => {
  navigateWithinRuntime(currentPath);
});

els.homeButton.addEventListener("click", navigateHome);
els.adminButton.addEventListener("click", navigateAdmin);
els.panelToggle.addEventListener("click", toggleSidePanel);
els.infoTab.addEventListener("click", () => setActivePanel("info"));
els.logsTab.addEventListener("click", () => setActivePanel("logs"));
els.phpInfoTab.addEventListener("click", () => {
  setActivePanel("phpinfo");
  capturePhpInfoViaWorker("tab-click");
});
els.blueprintTab.addEventListener("click", () => setActivePanel("blueprint"));
els.clearLogs.addEventListener("click", () => {
  els.logPanel.textContent = "";
});
els.copyLogs.addEventListener("click", () => {
  const text = els.logPanel.textContent || "";
  navigator.clipboard.writeText(text).then(() => {
    const original = els.copyLogs.textContent;
    els.copyLogs.textContent = "Copied!";
    setTimeout(() => {
      els.copyLogs.textContent = original;
    }, 1200);
  });
});
els.refreshPhpInfoButton.addEventListener("click", requestPhpInfoCapture);

els.addressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (uiLocked) {
    return;
  }
  navigateWithinRuntime(els.address.value || "/");
});

els.exportButton.addEventListener("click", () => {
  if (uiLocked) {
    return;
  }
  exportBlueprint();
});

els.importInput.addEventListener("change", async () => {
  const file = els.importInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    await importPayload(file);
    appendLog(`Imported configuration from ${file.name}`);
  } catch (error) {
    appendLog(String(error?.stack || error?.message || error), true);
  } finally {
    els.importInput.value = "";
  }
});

els.reset.addEventListener("click", () => {
  if (uiLocked) {
    return;
  }
  clearScopeSession(scopeId);
  // Clear the imported blueprint unless it was supplied via URL parameter,
  // so a plain reset boots without any previously loaded blueprint.
  if (!hasBlueprintUrlOverride(window.location.href)) {
    clearActiveBlueprint(scopeId);
    activeBlueprint = buildDefaultBlueprint(config);
    updateBlueprintTextarea();
  }
  currentPath = activeBlueprint?.landingPage || config.landingPath || "/";
  els.address.value = currentPath;
  pendingCleanBoot = true;
  remoteFrameBooted = false;
  serviceWorkerReady = null;
  setPhpInfoContent("");
  void updateFrame();
});

main().catch((error) => {
  setUiLocked(false);
  appendLog(String(error?.stack || error?.message || error), true);
});
