import { unzipSync } from "../../vendor/fflate/esm/browser.js";
import { resolveConfiguredProxyUrl } from "../shared/paths.js";

export const PERSIST_ADDONS_ROOT = "/persist/addons";
const MODULES_ROOT = `${PERSIST_ADDONS_ROOT}/modules`;
const THEMES_ROOT = `${PERSIST_ADDONS_ROOT}/themes`;
const MANIFESTS_ROOT = `${PERSIST_ADDONS_ROOT}/manifests`;
const EASY_ADMIN_CACHE_DIR = "data/playground-cache";
const EASY_ADMIN_REMOTE_SOURCES = [
  {
    url: "https://omeka.org/add-ons/json/s_module.json",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/s_module.json`,
  },
  {
    url: "https://omeka.org/add-ons/json/s_theme.json",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/s_theme.json`,
  },
  {
    url: "https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_modules.csv",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/omeka_s_modules.csv`,
  },
  {
    url: "https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_themes.csv",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/omeka_s_themes.csv`,
  },
  {
    url: "https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_selections.csv",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/omeka_s_selections.csv`,
  },
  {
    url: "https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/refs/heads/master/_data/omeka_s_selections.csv",
    relativePath: `${EASY_ADMIN_CACHE_DIR}/omeka_s_selections.csv`,
  },
];

function ensureDirSync(FS, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = FS.analyzePath(current);
    if (!about?.exists) {
      try {
        FS.mkdir(current);
      } catch {
        // Ignore existing directories.
      }
    }
  }
}

function removeNodeIfPresent(FS, path) {
  const about = FS.analyzePath(path);
  if (!about.exists) {
    return;
  }

  const mode = about.object?.mode;
  if (typeof mode === "number" && FS.isDir(mode)) {
    for (const entry of FS.readdir(path)) {
      if (entry === "." || entry === "..") {
        continue;
      }
      removeNodeIfPresent(FS, `${path}/${entry}`.replace(/\/{2,}/gu, "/"));
    }
    FS.rmdir(path);
    return;
  }

  FS.unlink(path);
}

function normalizeArchivePath(path) {
  return String(path || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/{2,}/gu, "/")
    .trim();
}

function isUnsafeArchivePath(path) {
  return path === ".."
    || path.startsWith("../")
    || path.includes("/../")
    || path.endsWith("/..");
}

function isSkippableArchivePath(path) {
  return !path
    || path.startsWith("__MACOSX/")
    || path === "__MACOSX"
    || path.endsWith("/.DS_Store")
    || path === ".DS_Store";
}

function getArchiveRoot(entries) {
  const roots = new Set();

  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry);
    if (isSkippableArchivePath(normalized)) {
      continue;
    }

    const [root] = normalized.split("/");
    if (root) {
      roots.add(root);
    }
  }

  return roots.size === 1 ? [...roots][0] : null;
}

function trimArchiveRoot(path, archiveRoot) {
  const normalized = normalizeArchivePath(path);
  if (!archiveRoot || !normalized) {
    return normalized;
  }

  if (normalized === archiveRoot) {
    return "";
  }

  if (normalized.startsWith(`${archiveRoot}/`)) {
    return normalized.slice(archiveRoot.length + 1);
  }

  return normalized;
}

function isDirectoryManifest(FS, path) {
  const about = FS.analyzePath(path);
  if (!about?.exists) {
    return false;
  }

  const mode = about.object?.mode;
  return typeof mode === "number" && FS.isDir(mode);
}

function directoryHasFiles(FS, path) {
  if (!isDirectoryManifest(FS, path)) {
    return false;
  }

  return FS.readdir(path).some((entry) => entry !== "." && entry !== "..");
}

function readJsonSync(FS, path) {
  const about = FS.analyzePath(path);
  if (!about?.exists) {
    return null;
  }

  return JSON.parse(FS.readFile(path, { encoding: "utf8" }));
}

function writeJsonSync(FS, path, value) {
  ensureDirSync(FS, path.split("/").slice(0, -1).join("/") || "/");
  FS.writeFile(path, JSON.stringify(value, null, 2));
}

function sanitizeSegment(value, fallback) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return sanitized || fallback;
}

function buildPageUrl(kind, slug) {
  const base = kind === "module" ? "https://omeka.org/s/modules/" : "https://omeka.org/s/themes/";
  return new URL(`${encodeURIComponent(slug).replace(/%2F/gu, "/")}/`, base).toString();
}

function parseDownloadLink(html, pageUrl) {
  const anchorPattern = /<a[^>]+href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/giu;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[2]?.trim();
    const label = match[3]?.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim() || "";
    if (!href) {
      continue;
    }

    if (/\.zip(?:[?#]|$)/iu.test(href) && /\bdownload\b/iu.test(label)) {
      return new URL(href, pageUrl).toString();
    }
  }

  anchorPattern.lastIndex = 0;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[2]?.trim();
    if (href && /\.zip(?:[?#]|$)/iu.test(href)) {
      return new URL(href, pageUrl).toString();
    }
  }

  return null;
}

async function resolveOmekaOrgSource(kind, source) {
  const slug = String(source.slug || "").trim();
  if (!slug) {
    throw new Error(`Missing omeka.org slug for ${kind}.`);
  }

  const pageUrl = buildPageUrl(kind, slug);
  const response = await fetch(pageUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load ${pageUrl}: ${response.status}`);
  }

  const html = await response.text();
  const downloadUrl = parseDownloadLink(html, pageUrl);
  if (!downloadUrl) {
    throw new Error(`No download link found on ${pageUrl}.`);
  }

  return {
    slug,
    pageUrl,
    downloadUrl,
  };
}

async function fetchZipBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to download ${url}: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function buildDownloadUrl(downloadUrl, config) {
  const rawUrl = String(downloadUrl || "").trim();
  if (!rawUrl) {
    return rawUrl;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, self.location.href);
  } catch {
    return rawUrl;
  }

  if (parsed.origin === self.location.origin) {
    return parsed.toString();
  }

  const proxied = resolveConfiguredProxyUrl(config, self.location?.href);
  if (!proxied) {
    return parsed.toString();
  }
  proxied.searchParams.set("url", parsed.toString());
  return proxied.toString();
}

function writeArchiveToFs(FS, targetDir, zipBytes) {
  const archive = unzipSync(zipBytes);
  const archiveEntries = Object.keys(archive);
  const archiveRoot = getArchiveRoot(archiveEntries);

  ensureDirSync(FS, targetDir);

  let writtenFiles = 0;
  for (const entryName of archiveEntries) {
    const normalizedEntryName = normalizeArchivePath(entryName);
    const isDirectoryEntry = /\/$/u.test(entryName) || /\/$/u.test(normalizedEntryName);
    const trimmedPath = trimArchiveRoot(entryName, archiveRoot);
    const relativePath = normalizeArchivePath(trimmedPath);

    if (isSkippableArchivePath(relativePath) || !relativePath) {
      continue;
    }

    if (isUnsafeArchivePath(relativePath)) {
      throw new Error(`Archive contains unsafe path "${relativePath}".`);
    }

    if (isDirectoryEntry) {
      ensureDirSync(FS, `${targetDir}/${relativePath}`.replace(/\/{2,}/gu, "/"));
      continue;
    }

    const fileBytes = archive[entryName];
    if (!(fileBytes instanceof Uint8Array)) {
      continue;
    }

    const targetPath = `${targetDir}/${relativePath}`.replace(/\/{2,}/gu, "/");
    const parentDir = targetPath.split("/").slice(0, -1).join("/") || "/";
    ensureDirSync(FS, parentDir);
    FS.writeFile(targetPath, fileBytes);
    writtenFiles += 1;
  }

  if (!writtenFiles) {
    throw new Error("Archive did not contain any installable files.");
  }
}

function pathExists(FS, path) {
  return FS.analyzePath(path)?.exists || false;
}

async function prepareEasyAdminCatalogCache(FS, persistedPath, config) {
  for (const source of EASY_ADMIN_REMOTE_SOURCES) {
    const targetPath = `${persistedPath}/${source.relativePath}`.replace(/\/{2,}/gu, "/");
    const targetDir = targetPath.split("/").slice(0, -1).join("/") || "/";
    ensureDirSync(FS, targetDir);

    if (!pathExists(FS, targetPath)) {
      const bytes = await fetchZipBytes(buildDownloadUrl(source.url, config));
      FS.writeFile(targetPath, bytes);
    }
  }
}

async function patchEasyAdminAddon(FS, persistedPath, config) {
  await prepareEasyAdminCatalogCache(FS, persistedPath, config);
  const addonPluginPath = `${persistedPath}/src/Mvc/Controller/Plugin/Addons.php`.replace(/\/{2,}/gu, "/");
  const addonsFormFactoryPath = `${persistedPath}/src/Service/Form/AddonsFormFactory.php`.replace(/\/{2,}/gu, "/");
  // This compatibility layer is intentionally specific to EasyAdmin.
  // The module hardcodes remote catalog URLs and reads them directly from PHP.
  const moduleCacheRoot = "OMEKA_PATH . '/modules/EasyAdmin/data/playground-cache'";

  if (pathExists(FS, addonPluginPath)) {
    let raw = FS.readFile(addonPluginPath, { encoding: "utf8" });

    const sourceExpressionReplacements = new Map([
      ["'https://omeka.org/add-ons/json/s_module.json'", `${moduleCacheRoot} . '/s_module.json'`],
      ["'https://omeka.org/add-ons/json/s_theme.json'", `${moduleCacheRoot} . '/s_theme.json'`],
      ["'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_modules.csv'", `${moduleCacheRoot} . '/omeka_s_modules.csv'`],
      ["'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_themes.csv'", `${moduleCacheRoot} . '/omeka_s_themes.csv'`],
    ]);
    for (const [search, replace] of sourceExpressionReplacements.entries()) {
      raw = raw.split(search).join(replace);
    }

    raw = raw.replace(
      "@file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/refs/heads/master/_data/omeka_s_selections.csv')",
      `@file_get_contents(${moduleCacheRoot} . '/omeka_s_selections.csv')`,
    );
    raw = raw.replace(
      "@file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_selections.csv')",
      `@file_get_contents(${moduleCacheRoot} . '/omeka_s_selections.csv')`,
    );

    raw = raw.replace(
      "    protected function fileGetContents($url): ?string\n    {\n        $uri = new HttpUri($url);\n        $this->httpClient->reset();\n        $this->httpClient->setUri($uri);\n        try {\n            $response = $this->httpClient->send();\n            $response = $response->isOk() ? $response->getBody() : null;\n        } catch (RuntimeException $e) {\n            $response = null;\n        }\n",
      "    protected function fileGetContents($url): ?string\n    {\n        if (!preg_match('~^https?://~i', (string) $url)) {\n            $response = @file_get_contents($url) ?: null;\n        } else {\n            $uri = new HttpUri($url);\n            $this->httpClient->reset();\n            $this->httpClient->setUri($uri);\n            try {\n                $response = $this->httpClient->send();\n                $response = $response->isOk() ? $response->getBody() : null;\n            } catch (RuntimeException $e) {\n                $response = null;\n            }\n        }\n",
    );

    FS.writeFile(addonPluginPath, raw, { encoding: "utf8" });
  }

  if (pathExists(FS, addonsFormFactoryPath)) {
    let raw = FS.readFile(addonsFormFactoryPath, { encoding: "utf8" });
    raw = raw.replace(
      "@file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/refs/heads/master/_data/omeka_s_selections.csv')",
      `@file_get_contents(${moduleCacheRoot} . '/omeka_s_selections.csv')`,
    );
    raw = raw.replace(
      "@file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_selections.csv')",
      `@file_get_contents(${moduleCacheRoot} . '/omeka_s_selections.csv')`,
    );
    FS.writeFile(addonsFormFactoryPath, raw, { encoding: "utf8" });
  }
}

function copyTreeSync(FS, sourcePath, targetPath) {
  const about = FS.analyzePath(sourcePath);
  if (!about?.exists) {
    throw new Error(`Source path "${sourcePath}" does not exist.`);
  }

  const mode = about.object?.mode;
  if (typeof mode === "number" && FS.isDir(mode)) {
    ensureDirSync(FS, targetPath);
    for (const entry of FS.readdir(sourcePath)) {
      if (entry === "." || entry === "..") {
        continue;
      }
      copyTreeSync(
        FS,
        `${sourcePath}/${entry}`.replace(/\/{2,}/gu, "/"),
        `${targetPath}/${entry}`.replace(/\/{2,}/gu, "/"),
      );
    }
    return;
  }

  const parentDir = targetPath.split("/").slice(0, -1).join("/") || "/";
  ensureDirSync(FS, parentDir);
  FS.writeFile(targetPath, FS.readFile(sourcePath));
}

function ensureAddonMount(FS, targetPath, sourcePath) {
  removeNodeIfPresent(FS, targetPath);
  copyTreeSync(FS, sourcePath, targetPath);
}

async function resolveSource(kind, spec) {
  const type = spec.source?.type || "bundled";
  if (type === "bundled") {
    return {
      type,
      fingerprint: `bundled:${spec.name}`,
      downloadUrl: null,
      pageUrl: null,
      slug: null,
    };
  }

  if (type === "url") {
    const downloadUrl = String(spec.source?.url || "").trim();
    if (!downloadUrl) {
      throw new Error(`Missing download URL for ${kind} "${spec.name}".`);
    }

    return {
      type,
      fingerprint: `url:${downloadUrl}`,
      downloadUrl,
      pageUrl: null,
      slug: null,
    };
  }

  if (type === "omeka.org") {
    const resolved = await resolveOmekaOrgSource(kind, spec.source || {});
    return {
      type,
      fingerprint: `omeka.org:${kind}:${resolved.slug}:${resolved.downloadUrl}`,
      downloadUrl: resolved.downloadUrl,
      pageUrl: resolved.pageUrl,
      slug: resolved.slug,
    };
  }

  throw new Error(`Unsupported addon source type "${type}" for ${kind} "${spec.name}".`);
}

function getCollectionRoot(kind) {
  return kind === "module" ? MODULES_ROOT : THEMES_ROOT;
}

function getMountRoot(omekaRoot, kind) {
  return `${omekaRoot}/${kind === "module" ? "modules" : "themes"}`;
}

function getManifestPath(kind, name) {
  const safeName = sanitizeSegment(name, kind);
  return `${MANIFESTS_ROOT}/${kind}s/${safeName}.json`;
}

function getPersistedAddonPath(kind, name) {
  return `${getCollectionRoot(kind)}/${name}`;
}

async function materializeAddon({ FS, kind, spec, omekaRoot, publish, config }) {
  const source = await resolveSource(kind, spec);
  const persistedPath = getPersistedAddonPath(kind, spec.name);
  const manifestPath = getManifestPath(kind, spec.name);
  const mountPath = `${getMountRoot(omekaRoot, kind)}/${spec.name}`;

  if (source.type === "bundled") {
    return {
      kind,
      name: spec.name,
      source,
      mountPath,
      persistedPath: null,
      cached: true,
    };
  }

  const existingManifest = readJsonSync(FS, manifestPath);
  const hasCachedFiles = directoryHasFiles(FS, persistedPath);
  const cacheHit = existingManifest?.fingerprint === source.fingerprint && hasCachedFiles;

  if (!cacheHit) {
    publish(`Fetching ${kind} "${spec.name}".`, 0.53);
    const zipBytes = await fetchZipBytes(buildDownloadUrl(source.downloadUrl, config));

    publish(`Extracting ${kind} "${spec.name}".`, 0.57);
    removeNodeIfPresent(FS, persistedPath);
    ensureDirSync(FS, persistedPath);
    writeArchiveToFs(FS, persistedPath, zipBytes);
    writeJsonSync(FS, manifestPath, {
      name: spec.name,
      kind,
      fingerprint: source.fingerprint,
      source,
      downloadedAt: new Date().toISOString(),
    });
  }

  if (kind === "module" && spec.name === "EasyAdmin") {
    publish(`Applying EasyAdmin-specific catalog compatibility patch.`, 0.58);
    await patchEasyAdminAddon(FS, persistedPath, config);
  }

  ensureAddonMount(FS, mountPath, persistedPath);

  return {
    kind,
    name: spec.name,
    source,
    mountPath,
    persistedPath,
    cached: cacheHit,
  };
}

export async function materializeBlueprintAddons({ php, blueprint, omekaRoot, publish, config }) {
  const binary = await php.binary;
  const { FS } = binary;

  for (const path of [PERSIST_ADDONS_ROOT, MODULES_ROOT, THEMES_ROOT, MANIFESTS_ROOT, `${MANIFESTS_ROOT}/modules`, `${MANIFESTS_ROOT}/themes`]) {
    ensureDirSync(FS, path);
  }

  const summary = {
    modules: [],
    themes: [],
  };

  for (const moduleSpec of blueprint.modules || []) {
    summary.modules.push(await materializeAddon({
      FS,
      kind: "module",
      spec: moduleSpec,
      omekaRoot,
      publish,
      config,
    }));
  }

  for (const themeSpec of blueprint.themes || []) {
    summary.themes.push(await materializeAddon({
      FS,
      kind: "theme",
      spec: themeSpec,
      omekaRoot,
      publish,
      config,
    }));
  }

  return summary;
}
