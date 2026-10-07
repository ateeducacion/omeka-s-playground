import { streamZipEntries } from "../../lib/omeka-loader.js";
import {
  OMEKA_CATALOG_URLS,
  resolveCatalogRelease,
} from "../shared/omeka-catalog.js";
import {
  patchEasyAdminGitLabArchiveFallback,
  patchEasyAdminSqliteSessionSupport,
} from "./easyadmin-patches.js";
import { APP_LOCATION, resolveProxyUrl } from "./networking.js";

export const PERSIST_ADDONS_ROOT = "/persist/addons";
const MODULES_ROOT = `${PERSIST_ADDONS_ROOT}/modules`;
const THEMES_ROOT = `${PERSIST_ADDONS_ROOT}/themes`;
const MANIFESTS_ROOT = `${PERSIST_ADDONS_ROOT}/manifests`;
const FILES_ROOT = `${PERSIST_ADDONS_ROOT}/files`;
const FILES_MANIFEST = `${MANIFESTS_ROOT}/files.json`;
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
];

const APP_ORIGIN = new URL(APP_LOCATION).origin;

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
  return (
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path.endsWith("/..")
  );
}

function isSkippableArchivePath(path) {
  return (
    !path ||
    path.startsWith("__MACOSX/") ||
    path === "__MACOSX" ||
    path.endsWith("/.DS_Store") ||
    path === ".DS_Store"
  );
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
  const base =
    kind === "module"
      ? "https://omeka.org/s/modules/"
      : "https://omeka.org/s/themes/";
  return new URL(
    `${encodeURIComponent(slug).replace(/%2F/gu, "/")}/`,
    base,
  ).toString();
}

function parseDownloadLink(html, pageUrl) {
  const anchorPattern = /<a[^>]+href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/giu;
  let match;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[2]?.trim();
    const label =
      match[3]
        ?.replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim() || "";
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

async function resolveOmekaOrgSource(kind, source, proxyBaseUrl) {
  const slug = String(source.slug || "").trim();
  if (!slug) {
    throw new Error(`Missing omeka.org slug for ${kind}.`);
  }

  const pageUrl = buildPageUrl(kind, slug);
  const response = await fetch(buildDownloadUrl(pageUrl, proxyBaseUrl), {
    cache: "no-store",
  });
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

// An add-on without a source that the core does not ship: resolve its name
// through the omeka.org catalog. The fingerprint does not need the download URL,
// so a cached add-on boots without fetching the catalog again.
function catalogSource(kind, spec) {
  return {
    type: "omeka.org-catalog",
    fingerprint: `catalog:${kind}:${spec.name}:${spec.version || "latest"}`,
    downloadUrl: null,
    pageUrl: null,
    slug: null,
  };
}

async function resolveCatalogDownloadUrl(kind, spec, proxyBaseUrl) {
  const bytes = await fetchBytes(
    buildDownloadUrl(OMEKA_CATALOG_URLS[kind], proxyBaseUrl),
  );
  const catalog = JSON.parse(new TextDecoder().decode(bytes));
  return resolveCatalogRelease(catalog, spec.name, spec.version);
}

async function fetchBytes(url) {
  let response;
  try {
    response = await fetch(String(url), { cache: "no-store" });
  } catch (error) {
    throw new Error(
      `Unable to download ${url}: ${error?.message || String(error)}`,
    );
  }

  // Retry once on transient CDN/proxy errors
  if (!response.ok && (response.status === 502 || response.status === 503)) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      response = await fetch(String(url), { cache: "no-store" });
    } catch (error) {
      throw new Error(
        `Unable to download ${url}: ${error?.message || String(error)}`,
      );
    }
  }

  if (!response.ok) {
    throw new Error(`Unable to download ${url}: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function buildDownloadUrl(downloadUrl, proxyBaseUrl) {
  const rawUrl = String(downloadUrl || "").trim();
  if (!rawUrl) {
    return rawUrl;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, APP_LOCATION);
  } catch {
    return rawUrl;
  }

  if (parsed.origin === APP_ORIGIN) {
    return parsed.toString();
  }

  if (!proxyBaseUrl) {
    return parsed.toString();
  }

  const proxied = new URL(proxyBaseUrl.toString());
  proxied.searchParams.set("url", parsed.toString());
  return proxied.toString();
}

async function writeArchiveToFs(FS, targetDir, zipBytes) {
  ensureDirSync(FS, targetDir);

  // Stream the add-on ZIP one entry at a time (via @php-wasm/stream-compression
  // decodeZip), writing each into MEMFS and releasing it before the next, so
  // peak memory stays ~one entry instead of the whole decompressed tree that
  // fflate's `unzipSync` held — the MEMFS OOM avoided here (same lesson as the
  // Nextcloud "extract apps with PHP ZipArchive" fix). External module/theme
  // ZIPs wrap their payload in a single top-level folder (the GitHub "repo-ref/"
  // or "ModuleName/" convention); detect it from the first nested entry so it
  // can be stripped, mirroring the previous getArchiveRoot() behavior without
  // buffering the whole archive.
  let archiveRoot = null;
  let rootResolved = false;
  let writtenFiles = 0;

  for await (const entry of streamZipEntries(zipBytes)) {
    const normalizedEntryName = normalizeArchivePath(entry.name);

    if (
      !rootResolved &&
      normalizedEntryName &&
      !isSkippableArchivePath(normalizedEntryName)
    ) {
      const [top, ...rest] = normalizedEntryName.split("/");
      archiveRoot = rest.length > 0 ? top : null;
      rootResolved = true;
    }

    const trimmedPath = trimArchiveRoot(entry.name, archiveRoot);
    const relativePath = normalizeArchivePath(trimmedPath);

    if (isSkippableArchivePath(relativePath) || !relativePath) {
      continue;
    }

    if (isUnsafeArchivePath(relativePath)) {
      throw new Error(`Archive contains unsafe path "${relativePath}".`);
    }

    const targetPath = `${targetDir}/${relativePath}`.replace(/\/{2,}/gu, "/");

    if (entry.isDirectory) {
      ensureDirSync(FS, targetPath);
      continue;
    }

    if (!(entry.data instanceof Uint8Array)) {
      continue;
    }

    const parentDir = targetPath.split("/").slice(0, -1).join("/") || "/";
    ensureDirSync(FS, parentDir);
    FS.writeFile(targetPath, entry.data);
    writtenFiles += 1;
  }

  if (!writtenFiles) {
    throw new Error("Archive did not contain any installable files.");
  }
}

function pathExists(FS, path) {
  return FS.analyzePath(path)?.exists || false;
}

async function prepareEasyAdminCatalogCache(FS, persistedPath, proxyBaseUrl) {
  for (const source of EASY_ADMIN_REMOTE_SOURCES) {
    const targetPath = `${persistedPath}/${source.relativePath}`.replace(
      /\/{2,}/gu,
      "/",
    );
    const targetDir = targetPath.split("/").slice(0, -1).join("/") || "/";
    ensureDirSync(FS, targetDir);

    if (!pathExists(FS, targetPath)) {
      const bytes = await fetchBytes(
        buildDownloadUrl(source.url, proxyBaseUrl),
      );
      FS.writeFile(targetPath, bytes);
    }
  }
}

async function patchEasyAdminAddon(FS, persistedPath, proxyBaseUrl) {
  await prepareEasyAdminCatalogCache(FS, persistedPath, proxyBaseUrl);
  const addonPluginPath =
    `${persistedPath}/src/Mvc/Controller/Plugin/Addons.php`.replace(
      /\/{2,}/gu,
      "/",
    );
  const addonsFormFactoryPath =
    `${persistedPath}/src/Service/Form/AddonsFormFactory.php`.replace(
      /\/{2,}/gu,
      "/",
    );
  // This compatibility layer is intentionally specific to EasyAdmin.
  // The module hardcodes remote catalog URLs and reads them directly from PHP.
  const moduleCacheRoot =
    "OMEKA_PATH . '/modules/EasyAdmin/data/playground-cache'";

  if (pathExists(FS, addonPluginPath)) {
    let raw = FS.readFile(addonPluginPath, { encoding: "utf8" });

    const sourceExpressionReplacements = new Map([
      [
        "'https://omeka.org/add-ons/json/s_module.json'",
        `${moduleCacheRoot} . '/s_module.json'`,
      ],
      [
        "'https://omeka.org/add-ons/json/s_theme.json'",
        `${moduleCacheRoot} . '/s_theme.json'`,
      ],
      [
        "'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_modules.csv'",
        `${moduleCacheRoot} . '/omeka_s_modules.csv'`,
      ],
      [
        "'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_themes.csv'",
        `${moduleCacheRoot} . '/omeka_s_themes.csv'`,
      ],
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
    raw = patchEasyAdminGitLabArchiveFallback(raw);
    raw = patchEasyAdminSqliteSessionSupport(raw);

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

  const cronTasksPath = `${persistedPath}/src/Job/CronTasks.php`.replace(
    /\/{2,}/gu,
    "/",
  );
  if (pathExists(FS, cronTasksPath)) {
    const raw = patchEasyAdminSqliteSessionSupport(
      FS.readFile(cronTasksPath, { encoding: "utf8" }),
    );
    FS.writeFile(cronTasksPath, raw, { encoding: "utf8" });
  }

  const dbSessionPath = `${persistedPath}/src/Job/DbSession.php`.replace(
    /\/{2,}/gu,
    "/",
  );
  if (pathExists(FS, dbSessionPath)) {
    const raw = patchEasyAdminSqliteSessionSupport(
      FS.readFile(dbSessionPath, { encoding: "utf8" }),
    );
    FS.writeFile(dbSessionPath, raw, { encoding: "utf8" });
  }

  const modulePhpPath = `${persistedPath}/Module.php`.replace(/\/{2,}/gu, "/");
  if (pathExists(FS, modulePhpPath)) {
    const raw = patchEasyAdminSqliteSessionSupport(
      FS.readFile(modulePhpPath, { encoding: "utf8" }),
    );
    FS.writeFile(modulePhpPath, raw, { encoding: "utf8" });
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

async function resolveSource(kind, spec, proxyBaseUrl) {
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
    const resolved = await resolveOmekaOrgSource(
      kind,
      spec.source || {},
      proxyBaseUrl,
    );
    return {
      type,
      fingerprint: `omeka.org:${kind}:${resolved.slug}:${resolved.downloadUrl}`,
      downloadUrl: resolved.downloadUrl,
      pageUrl: resolved.pageUrl,
      slug: resolved.slug,
    };
  }

  throw new Error(
    `Unsupported addon source type "${type}" for ${kind} "${spec.name}".`,
  );
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

// Copy the persisted blueprint files onto the Omeka S root, which is rebuilt
// from the readonly core on every boot. Archives overlay their directory.
function mountPersistedFiles(FS, omekaRoot) {
  for (const file of readJsonSync(FS, FILES_MANIFEST)?.files || []) {
    if (!pathExists(FS, file.persistedPath)) {
      continue;
    }
    const target = resolveAssetTarget(omekaRoot, file.destination);
    if (file.extract) {
      copyTreeSync(FS, file.persistedPath, target);
    } else {
      ensureDirSync(FS, target.split("/").slice(0, -1).join("/") || "/");
      FS.writeFile(target, FS.readFile(file.persistedPath));
    }
  }
}

export async function mountPersistedAddons({ php, omekaRoot }) {
  const binary = await php.binary;
  const { FS } = binary;

  for (const kind of ["module", "theme"]) {
    const collectionRoot = getCollectionRoot(kind);
    if (!pathExists(FS, collectionRoot)) {
      continue;
    }

    const mountRoot = getMountRoot(omekaRoot, kind);
    ensureDirSync(FS, mountRoot);

    for (const entry of FS.readdir(collectionRoot)) {
      if (entry === "." || entry === "..") {
        continue;
      }

      const sourcePath = `${collectionRoot}/${entry}`.replace(/\/{2,}/gu, "/");
      if (!isDirectoryManifest(FS, sourcePath)) {
        continue;
      }

      const targetPath = `${mountRoot}/${entry}`.replace(/\/{2,}/gu, "/");
      ensureAddonMount(FS, targetPath, sourcePath);
    }
  }

  mountPersistedFiles(FS, omekaRoot);
}

// Normalize the optional `assets` list on an add-on spec. Each asset overlays
// an extra ZIP payload (e.g. a separately published static editor bundle) onto
// the installed add-on directory after the add-on itself is extracted.
function resolveAddonAssets(spec) {
  if (!Array.isArray(spec.assets)) {
    return [];
  }
  return spec.assets
    .map((asset) => ({
      url: String(asset?.url || "").trim(),
      destination: String(asset?.destination || "").trim(),
    }))
    .filter((asset) => asset.url && asset.destination);
}

// Fold the asset list into the cache fingerprint so changing an asset URL or
// destination busts the cached add-on and re-extracts everything.
function assetsFingerprint(assets) {
  if (!assets.length) {
    return "";
  }
  return `|assets:${assets
    .map((asset) => `${asset.url}->${asset.destination}`)
    .join(",")}`;
}

// Resolve (and harden) an asset destination relative to the add-on root.
function resolveAssetTarget(persistedPath, destination) {
  const relative = normalizeArchivePath(destination);
  if (!relative || isUnsafeArchivePath(relative)) {
    throw new Error(`Unsafe add-on asset destination "${destination}".`);
  }
  return `${persistedPath}/${relative}`.replace(/\/{2,}/gu, "/");
}

async function materializeAddon({
  FS,
  kind,
  spec,
  omekaRoot,
  publish,
  proxyBaseUrl,
}) {
  let source = await resolveSource(kind, spec, proxyBaseUrl);
  const persistedPath = getPersistedAddonPath(kind, spec.name);
  const manifestPath = getManifestPath(kind, spec.name);
  const mountPath = `${getMountRoot(omekaRoot, kind)}/${spec.name}`;

  if (source.type === "bundled" && !pathExists(FS, mountPath)) {
    source = catalogSource(kind, spec);
  }

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

  const assets = resolveAddonAssets(spec);
  const fingerprint = `${source.fingerprint}${assetsFingerprint(assets)}`;

  const existingManifest = readJsonSync(FS, manifestPath);
  const hasCachedFiles = directoryHasFiles(FS, persistedPath);
  const cacheHit =
    existingManifest?.fingerprint === fingerprint && hasCachedFiles;

  if (!cacheHit) {
    publish(`Fetching ${kind} "${spec.name}".`, 0.53);
    removeNodeIfPresent(FS, persistedPath);
    ensureDirSync(FS, persistedPath);

    const downloadUrl =
      source.downloadUrl ??
      (await resolveCatalogDownloadUrl(kind, spec, proxyBaseUrl));
    const zipBytes = await fetchBytes(
      buildDownloadUrl(downloadUrl, proxyBaseUrl),
    );
    publish(`Extracting ${kind} "${spec.name}".`, 0.57);
    await writeArchiveToFs(FS, persistedPath, zipBytes);

    // Overlay any declared asset archives (e.g. a separately published static
    // editor bundle) onto the add-on directory. writeArchiveToFs strips a
    // single top-level wrapper folder, so an archive that wraps its payload in
    // "static/" lands directly under the requested destination.
    for (const asset of assets) {
      const assetTarget = resolveAssetTarget(persistedPath, asset.destination);
      publish(`Fetching asset for ${kind} "${spec.name}".`, 0.56);
      const assetBytes = await fetchBytes(
        buildDownloadUrl(asset.url, proxyBaseUrl),
      );
      await writeArchiveToFs(FS, assetTarget, assetBytes);
    }

    writeJsonSync(FS, manifestPath, {
      name: spec.name,
      kind,
      fingerprint,
      source,
      assets,
      downloadedAt: new Date().toISOString(),
    });
  }

  if (kind === "module" && spec.name === "EasyAdmin") {
    publish(`Applying EasyAdmin-specific catalog compatibility patch.`, 0.58);
    await patchEasyAdminAddon(FS, persistedPath, proxyBaseUrl);
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

export async function materializeBlueprintAddons({
  php,
  blueprint,
  omekaRoot,
  publish,
  config,
}) {
  const binary = await php.binary;
  const { FS } = binary;
  const proxyBaseUrl = resolveProxyUrl(config);

  for (const path of [
    PERSIST_ADDONS_ROOT,
    MODULES_ROOT,
    THEMES_ROOT,
    MANIFESTS_ROOT,
    `${MANIFESTS_ROOT}/modules`,
    `${MANIFESTS_ROOT}/themes`,
  ]) {
    ensureDirSync(FS, path);
  }

  const summary = {
    modules: [],
    themes: [],
  };

  for (const moduleSpec of blueprint.modules || []) {
    summary.modules.push(
      await materializeAddon({
        FS,
        kind: "module",
        spec: moduleSpec,
        omekaRoot,
        publish,
        proxyBaseUrl,
      }),
    );
  }

  for (const themeSpec of blueprint.themes || []) {
    summary.themes.push(
      await materializeAddon({
        FS,
        kind: "theme",
        spec: themeSpec,
        omekaRoot,
        publish,
        proxyBaseUrl,
      }),
    );
  }

  return summary;
}

/**
 * Fetch the blueprint `files` (cached under /persist by source and extract flag)
 * and place them in the Omeka S root, after the add-ons so they can overlay them.
 */
export async function materializeBlueprintFiles({
  php,
  blueprint,
  omekaRoot,
  publish,
  config,
}) {
  const binary = await php.binary;
  const { FS } = binary;
  const proxyBaseUrl = resolveProxyUrl(config);
  const previous = new Map(
    (readJsonSync(FS, FILES_MANIFEST)?.files || []).map((file) => [
      file.persistedPath,
      file,
    ]),
  );

  const files = [];
  for (const file of blueprint.files || []) {
    const fingerprint = `${file.source}|extract:${file.extract}`;
    const persistedPath = `${FILES_ROOT}/${sanitizeSegment(file.destination, "file")}`;
    // validates the destination before anything is downloaded
    resolveAssetTarget(omekaRoot, file.destination);

    const cached = previous.get(persistedPath);
    if (cached?.fingerprint !== fingerprint || !pathExists(FS, persistedPath)) {
      publish(`Fetching file "${file.destination}".`, 0.55);
      removeNodeIfPresent(FS, persistedPath);
      const bytes = await fetchBytes(
        buildDownloadUrl(file.source, proxyBaseUrl),
      );
      if (file.extract) {
        await writeArchiveToFs(FS, persistedPath, bytes);
      } else {
        ensureDirSync(FS, FILES_ROOT);
        FS.writeFile(persistedPath, bytes);
      }
    }
    previous.delete(persistedPath);
    files.push({
      destination: file.destination,
      extract: file.extract,
      fingerprint,
      persistedPath,
    });
  }

  // files no longer in the blueprint
  for (const stale of previous.keys()) {
    removeNodeIfPresent(FS, stale);
  }
  writeJsonSync(FS, FILES_MANIFEST, { files });
  mountPersistedFiles(FS, omekaRoot);
  return files;
}

const SOURCES_ROOT = `${PERSIST_ADDONS_ROOT}/sources`;

/**
 * Download the `source` of each blueprint vocabulary and resource template
 * (through the add-on proxy, as files are) and cache it under /persist, so a
 * reload does not fetch it again. Returns a copy of the blueprint whose entries
 * carry the `cachedPath` the install script reads.
 */
export async function materializeBlueprintSources({
  php,
  blueprint,
  publish,
  config,
}) {
  const binary = await php.binary;
  const { FS } = binary;
  const proxyBaseUrl = resolveProxyUrl(config);
  const staged = structuredClone(blueprint);
  const kept = new Set();

  const entries = [
    ...(staged.vocabularies || []).map((entry) => [
      `vocabulary "${entry.prefix}"`,
      entry,
    ]),
    ...(staged.resourceTemplates || []).map((entry) => [
      `resource template "${entry.label || entry.source}"`,
      entry,
    ]),
  ];
  for (const [what, entry] of entries) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(entry.source),
    );
    const name = [...new Uint8Array(digest).slice(0, 16)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const cachedPath = `${SOURCES_ROOT}/${name}`;
    if (!pathExists(FS, cachedPath)) {
      publish(`Fetching the ${what} source.`, 0.55);
      // Directly first: RDF hosts such as schema.org and dublincore.org allow
      // CORS, and the production proxy only serves add-on hosts. Then through
      // the proxy, for hosts without CORS.
      let bytes;
      try {
        bytes = await fetchBytes(entry.source);
      } catch (directError) {
        const proxied = buildDownloadUrl(entry.source, proxyBaseUrl);
        try {
          if (proxied === entry.source) {
            throw directError;
          }
          bytes = await fetchBytes(proxied);
        } catch (error) {
          throw new Error(
            `Blueprint ${what}: unable to download ${entry.source} (${error.message}).`,
          );
        }
      }
      ensureDirSync(FS, SOURCES_ROOT);
      FS.writeFile(cachedPath, bytes);
    }
    entry.cachedPath = cachedPath;
    kept.add(name);
  }

  // sources no longer in the blueprint
  if (pathExists(FS, SOURCES_ROOT)) {
    for (const name of FS.readdir(SOURCES_ROOT)) {
      if (name !== "." && name !== ".." && !kept.has(name)) {
        removeNodeIfPresent(FS, `${SOURCES_ROOT}/${name}`);
      }
    }
  }
  return staged;
}
