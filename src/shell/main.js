import { BUILD_VERSION } from "../generated/build-version.js";
import {
  buildDefaultBlueprint,
  clearActiveBlueprint,
  encodeBlueprintParam,
  exportBlueprintPayload,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
} from "../shared/blueprint.js";
import { loadPlaygroundConfig } from "../shared/config.js";
import {
  captureException,
  captureMessage,
  initMonitoring,
} from "../shared/monitoring.js";
import {
  DEFAULT_OMEKA_VERSION,
  DEFAULT_PHP_VERSION,
  getCompatiblePhpVersions,
  OMEKA_VERSIONS,
  parseQueryParams,
  resolveRuntimeSelection,
} from "../shared/omeka-versions.js";
import {
  blueprintSourceKey,
  hasBlueprintUrlOverride,
  resolveRemoteUrl,
} from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import {
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../shared/storage.js";
import { initBlueprintEditor } from "./blueprint-editor.js";

const els = {
  addressForm: document.querySelector("#address-form"),
  address: document.querySelector("#address-input"),
  blueprintEditorMount: document.querySelector("#blueprint-editor"),
  blueprintPanel: document.querySelector("#blueprint-panel"),
  blueprintStatus: document.querySelector("#blueprint-status"),
  blueprintTab: document.querySelector("#blueprint-tab"),
  blueprintTextarea: document.querySelector("#blueprint-textarea"),
  clearLogs: document.querySelector("#clear-logs-button"),
  copyBlueprintButton: document.querySelector("#copy-button"),
  copyLogs: document.querySelector("#copy-logs-button"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  runButton: document.querySelector("#run-button"),
  frame: document.querySelector("#site-frame"),
  logPanel: document.querySelector("#log-panel"),
  logsPanel: document.querySelector("#logs-panel"),
  logsTab: document.querySelector("#logs-tab"),
  panelClose: document.querySelector("#panel-close-button"),
  panelToggle: document.querySelector("#panel-toggle-button"),
  phpInfoFrame: document.querySelector("#phpinfo-frame"),
  phpInfoPanel: document.querySelector("#phpinfo-panel"),
  phpInfoTab: document.querySelector("#phpinfo-tab"),
  refreshPhpInfoButton: document.querySelector("#refresh-phpinfo-button"),
  back: document.querySelector("#back-button"),
  refresh: document.querySelector("#refresh-button"),
  homeButton: document.querySelector("#home-button"),
  adminButton: document.querySelector("#admin-button"),
  reset: document.querySelector("#reset-button"),
  infoOmekaVersion: document.querySelector("#info-omeka-version"),
  infoPhpVersion: document.querySelector("#info-php-version"),
  configStatus: document.querySelector("#config-status"),
  configWarning: document.querySelector("#config-warning"),
  configApply: document.querySelector("#config-apply"),
  runtimeIdChip: document.querySelector("#runtime-id-chip"),
  runtimeIdValue: document.querySelector("#runtime-id-value"),
  buildIdChip: document.querySelector("#build-id-chip"),
  buildIdValue: document.querySelector("#build-id-value"),
  infoPanel: document.querySelector("#info-panel"),
  infoTab: document.querySelector("#info-tab"),
  sidePanel: document.querySelector("#side-panel"),
  workspace: document.querySelector("#workspace"),
};

const scopeId = getOrCreateScopeId();
let config;
const blueprintEditor = initBlueprintEditor(
  {
    mount: els.blueprintEditorMount,
    textarea: els.blueprintTextarea,
    statusEl: els.blueprintStatus,
    runButton: els.runButton,
    copyButton: els.copyBlueprintButton,
  },
  { getConfig: () => config },
);
let currentRuntimeId;
let currentPhpVersion = DEFAULT_PHP_VERSION;
let currentOmekaVersion = DEFAULT_OMEKA_VERSION;
let currentPath = "/";
// In-shell navigation history for the toolbar Back button. The iframe's own
// session history is not usable here (navigations happen across nested frames
// and service-worker scopes), so the shell tracks visited paths itself.
const backStack = [];
let suppressBackPush = false;
let channel;
let serviceWorkerReady = null;
let activeBlueprint;
let remoteFrameBooted = false;
let uiLocked = true;
const remoteReloadToken = 0;
let pendingCleanBoot = false;
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
  blueprintEditor.setLocked(locked);
  updateBackButton();
}

function updateBackButton() {
  if (els.back) {
    els.back.disabled = uiLocked || backStack.length === 0;
  }
}

function recordBackEntry(previousPath, nextPath) {
  const suppressed = suppressBackPush;
  suppressBackPush = false;
  if (!suppressed && previousPath && previousPath !== nextPath) {
    if (backStack[backStack.length - 1] !== previousPath) {
      backStack.push(previousPath);
    }
  }
  updateBackButton();
}

async function ensureRuntimeServiceWorker() {
  if (!config) {
    return;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  // Cache-bust the SW by the per-build worker-bundle hash so a redeploy is
  // always picked up (the old static config.bundleVersion was manual).
  swUrl.searchParams.set("v", BUILD_VERSION);
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

  const previousPath = currentPath;
  currentPath = path || "/";
  recordBackEntry(previousPath, currentPath);
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
  const result = blueprintEditor.getValidationResult();
  if (!result.valid) {
    appendLog(`Cannot export blueprint: ${result.message}`, true);
    return;
  }

  const blob = new Blob([JSON.stringify(result.blueprint, null, 2)], {
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
  if (!config || !activeBlueprint) {
    return;
  }

  blueprintEditor.setCode(
    JSON.stringify(exportBlueprintPayload(config, activeBlueprint), null, 2),
  );
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

  // Encode blueprint into URL and reload for clean WASM runtime. Gzipped +
  // base64url when the browser supports it, so shared links stay short.
  const encoded = await encodeBlueprintParam(imported.blueprint);
  const url = new URL(window.location.href);
  url.searchParams.set("blueprint", encoded);
  url.searchParams.delete("blueprint-url");
  url.searchParams.delete("blueprint-data");
  window.location.href = url.toString();
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
      case "ready": {
        // The remote frame emits "ready" before "navigate" on every iframe
        // load, so in-site navigations have to be recorded here: by the time
        // "navigate" arrives currentPath has already moved on and there is no
        // transition left to push. The first load is the landing redirect, not
        // a user navigation, so it is skipped.
        const wasBooted = remoteFrameBooted;
        remoteFrameBooted = true;
        setUiLocked(false);
        const nextPath = message.path || currentPath;
        if (wasBooted) {
          recordBackEntry(currentPath, nextPath);
        }
        currentPath = nextPath;
        els.address.value = currentPath;
        saveState({ lastReadyAt: new Date().toISOString() });
        break;
      }
      case "navigate": {
        const nextPath = message.path || "/";
        recordBackEntry(currentPath, nextPath);
        currentPath = nextPath;
        els.address.value = currentPath;
        saveState();
        break;
      }
      case "error":
        remoteFrameBooted = false;
        setUiLocked(false);
        appendLog(message.detail, true);
        captureMessage(message.detail, "error", { source: "runtime" });
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

function populateConfigSelects() {
  if (!els.infoOmekaVersion || !els.infoPhpVersion) {
    return;
  }

  // Populate Omeka version dropdown
  els.infoOmekaVersion.innerHTML = "";
  for (const entry of OMEKA_VERSIONS) {
    const option = document.createElement("option");
    option.value = entry.version;
    option.textContent = entry.label;
    els.infoOmekaVersion.append(option);
  }
  els.infoOmekaVersion.value = currentOmekaVersion;

  // Populate PHP version dropdown based on selected Omeka version
  updatePhpVersionDropdown(currentOmekaVersion);
  els.infoPhpVersion.value = currentPhpVersion;
}

function updatePhpVersionDropdown(omekaVersion) {
  if (!els.infoPhpVersion) {
    return;
  }

  const compatible = getCompatiblePhpVersions(omekaVersion);
  const previousValue = els.infoPhpVersion.value;
  els.infoPhpVersion.innerHTML = "";
  for (const version of compatible) {
    const option = document.createElement("option");
    option.value = version;
    option.textContent = `PHP ${version}`;
    els.infoPhpVersion.append(option);
  }

  // Keep current selection if still compatible, otherwise fall back
  if (compatible.includes(previousValue)) {
    els.infoPhpVersion.value = previousValue;
  } else if (compatible.includes(currentPhpVersion)) {
    els.infoPhpVersion.value = currentPhpVersion;
  } else if (compatible.includes(DEFAULT_PHP_VERSION)) {
    els.infoPhpVersion.value = DEFAULT_PHP_VERSION;
  } else {
    els.infoPhpVersion.value = compatible[0];
  }
}

// Reflect the applied runtime in the Info panel: when the selected versions
// differ from what is actually running the config is "dirty". Changing a version
// is destructive (it resets the site), so the Apply button stays hidden and the
// warning stays hidden until the selection actually differs.
function refreshDirtyState() {
  if (!els.infoOmekaVersion || !els.infoPhpVersion) {
    return;
  }
  const dirty =
    els.infoOmekaVersion.value !== currentOmekaVersion ||
    els.infoPhpVersion.value !== currentPhpVersion;

  if (els.configStatus) {
    els.configStatus.className = dirty ? "dirty-note" : "status-pill";
    els.configStatus.innerHTML = dirty
      ? '<span class="dot"></span>Unsaved'
      : '<span class="dot"></span>Running';
  }
  // Changing a version is destructive; the Apply button and warning only appear
  // once the selection differs from what is running. To revert, reselect the
  // original version — the dirty state clears itself.
  els.configWarning?.classList.toggle("is-hidden", !dirty);
  els.configApply?.classList.toggle("is-hidden", !dirty);
}

function updateConfigState() {
  if (els.runtimeIdValue) {
    els.runtimeIdValue.textContent = currentRuntimeId;
  }
  refreshDirtyState();
}

function applyConfigAndReset() {
  const newOmeka = els.infoOmekaVersion?.value;
  const newPhp = els.infoPhpVersion?.value;

  if (newOmeka === currentOmekaVersion && newPhp === currentPhpVersion) {
    return;
  }

  // Persist the choice via URL params and reload. Reloading gives us a
  // fresh WASM runtime, a fresh service worker registration, and rebuilds
  // the scope so stale per-version state can't leak across version swaps.
  const url = new URL(window.location.href);
  if (newPhp) {
    url.searchParams.set("php", newPhp);
  }
  if (newOmeka) {
    url.searchParams.set("omeka", newOmeka);
  }
  url.searchParams.delete("phpVersion");
  url.searchParams.delete("omekaVersion");
  // Clear any saved session state so the new version boots fresh.
  clearScopeSession(scopeId);
  window.location.href = url.toString();
}

async function main() {
  config = await loadPlaygroundConfig();
  activeBlueprint = await resolveBlueprintForShell(scopeId, config);
  updateBlueprintTextarea();

  // Reset the persisted env when the blueprint changed since the last boot in
  // this tab: a different blueprint must install fresh, not replay the previous
  // env (which the install gate would otherwise reuse). Reloading the same
  // blueprint keeps the data; a different tab is already clean (per-tab scopeId).
  const blueprintKey = blueprintSourceKey(window.location.href);
  const blueprintStoreKey = `blueprint-source:${scopeId}`;
  const previousBlueprintKey = window.sessionStorage.getItem(blueprintStoreKey);
  if (previousBlueprintKey !== null && previousBlueprintKey !== blueprintKey) {
    pendingCleanBoot = true;
  }
  window.sessionStorage.setItem(blueprintStoreKey, blueprintKey);

  const previous = loadSessionState(scopeId);
  const preferredPath =
    activeBlueprint?.landingPage || config.landingPath || "/";
  const shouldForceCleanBoot = pendingCleanBoot;
  const shouldBypassSavedLogin =
    config.autologin && previous?.path === "/login";

  // Resolve the runtime selection from (explicit URL params) >
  // (active blueprint preferred versions) > (saved session) >
  // (config defaults). On a forced clean boot we ignore the saved session
  // so the runtime always matches the resolved selection.
  const urlParams = parseQueryParams(window.location.href);
  const selection = resolveRuntimeSelection({
    php: urlParams.php || activeBlueprint?.preferredVersions?.php || undefined,
    omeka:
      urlParams.omeka || activeBlueprint?.preferredVersions?.omeka || undefined,
    runtimeId: shouldForceCleanBoot
      ? undefined
      : previous?.runtimeId ||
        config.runtimes?.find((r) => r.default)?.id ||
        config.runtimes?.[0]?.id,
  });
  currentPhpVersion = selection.phpVersion;
  currentOmekaVersion = selection.omekaVersion;
  currentRuntimeId = selection.runtimeId;
  appendLog(
    `Runtime selection: php=${currentPhpVersion}, omeka=${currentOmekaVersion}, runtime=${currentRuntimeId}`,
  );

  // Error monitoring (Sentry) — a no-op unless config.sentry.dsn is set.
  // The Playground Build ID is the Sentry release, so an issue names the exact
  // deployed artifact. See ADR-0028 and ADR-0029.
  initMonitoring({
    dsn: config.sentry?.dsn,
    environment: config.sentry?.environment,
    release: BUILD_VERSION,
    tags: {
      runtime: currentRuntimeId,
      omekaVersion: currentOmekaVersion,
      phpVersion: currentPhpVersion,
    },
  });

  // Build ID in the Runtime panel: the deployed Playground artifact, kept
  // distinct from the Omeka S version running inside it.
  if (els.buildIdValue) {
    els.buildIdValue.textContent = BUILD_VERSION;
  }
  if (els.buildIdChip) {
    els.buildIdChip.title = `Copy Playground build ID (${BUILD_VERSION})`;
  }
  // One startup line so a copied runtime log always names the deployed build.
  appendLog(`Playground build ${BUILD_VERSION}`);
  currentPath = shouldForceCleanBoot
    ? preferredPath
    : shouldBypassSavedLogin
      ? preferredPath
      : previous?.path || preferredPath;
  els.address.value = currentPath;

  populateConfigSelects();
  updateConfigState();

  // Configuration (Info panel) event listeners
  if (els.infoOmekaVersion) {
    els.infoOmekaVersion.addEventListener("change", () => {
      updatePhpVersionDropdown(els.infoOmekaVersion.value);
      refreshDirtyState();
    });
  }
  if (els.infoPhpVersion) {
    els.infoPhpVersion.addEventListener("change", refreshDirtyState);
  }
  if (els.configApply) {
    els.configApply.addEventListener("click", applyConfigAndReset);
  }
  if (els.runtimeIdChip) {
    els.runtimeIdChip.addEventListener("click", () => {
      navigator.clipboard?.writeText(currentRuntimeId || "");
      const label = els.runtimeIdValue;
      if (!label) {
        return;
      }
      const original = label.textContent;
      label.textContent = "✓ copied";
      setTimeout(() => {
        label.textContent = original;
      }, 1400);
    });
  }
  if (els.buildIdChip) {
    els.buildIdChip.addEventListener("click", () => {
      navigator.clipboard?.writeText(BUILD_VERSION);
      const label = els.buildIdValue;
      if (!label) {
        return;
      }
      label.textContent = "✓ copied";
      setTimeout(() => {
        label.textContent = BUILD_VERSION;
      }, 1400);
    });
  }

  bindShellChannel();
  bindServiceWorkerMessages();
  setPhpInfoContent("");
  setUiLocked(true);
  await updateFrame();
}

els.back.addEventListener("click", () => {
  if (uiLocked || backStack.length === 0) {
    return;
  }
  const previousPath = backStack.pop();
  updateBackButton();
  suppressBackPush = true;
  navigateWithinRuntime(previousPath);
});

els.refresh.addEventListener("click", () => {
  navigateWithinRuntime(currentPath);
});

els.homeButton.addEventListener("click", navigateHome);
els.adminButton.addEventListener("click", navigateAdmin);
els.panelToggle.addEventListener("click", toggleSidePanel);
els.panelClose.addEventListener("click", () => {
  if (!els.sidePanel.classList.contains("is-collapsed")) {
    toggleSidePanel();
  }
});
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
    // Icon-only button: swap the SVG for a checkmark, then restore it.
    const original = els.copyLogs.innerHTML;
    els.copyLogs.textContent = "✓";
    setTimeout(() => {
      els.copyLogs.innerHTML = original;
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
  backStack.length = 0;
  updateBackButton();
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
  captureException(error, { source: "shell-main" });
});
