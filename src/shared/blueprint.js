import {
  DEFAULT_OMEKA_VERSION,
  DEFAULT_PHP_VERSION,
  resolveOmekaVersion,
} from "./omeka-versions.js";
import { resolveProjectUrl } from "./paths.js";
import { SNAPSHOT_VERSION } from "./protocol.js";

const BLUEPRINT_KEY_PREFIX = "omeka-playground:blueprint";

function hasWindow() {
  return typeof window !== "undefined";
}

function absolutizeUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  if (!hasWindow()) {
    return text;
  }

  try {
    return new URL(text, window.location.href).toString();
  } catch {
    return text;
  }
}

function getBlueprintStorageKey(scopeId) {
  return `${BLUEPRINT_KEY_PREFIX}:${scopeId}`;
}

// --- Inline blueprint URL payloads ----------------------------------------
// Inline blueprints travel in the URL (?blueprint=) as base64url. To keep
// shareable links short, the JSON is gzip-compressed first when the browser
// supports the Compression Streams API; the compressed bytes keep the standard
// gzip magic (0x1f 0x8b) so the decoder can tell a compressed payload from a
// plain one. Plain base64 JSON (older links, or browsers without the API) keeps
// working unchanged — the decoder accepts both base64 and base64url alphabets.

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function bytesFromBase64(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .replace(/\s+/gu, "");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;

  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Blueprint data payload is not valid base64.");
  }

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasGzipMagic(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function pipeThroughStream(bytes, transform) {
  const piped = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function gzipBytes(bytes) {
  return pipeThroughStream(bytes, new CompressionStream("gzip"));
}

async function gunzipBytes(bytes) {
  return pipeThroughStream(bytes, new DecompressionStream("gzip"));
}

/**
 * Encode a blueprint object into the compact base64url payload used in
 * ?blueprint= links. Gzips the JSON when the browser supports it (and the
 * result is actually smaller); otherwise emits plain base64url JSON.
 */
export async function encodeBlueprintParam(blueprint) {
  const utf8 = new TextEncoder().encode(JSON.stringify(blueprint));
  if (typeof CompressionStream === "function") {
    try {
      const gzipped = await gzipBytes(utf8);
      if (gzipped.length < utf8.length) {
        return base64UrlFromBytes(gzipped);
      }
    } catch {
      // Compression unavailable at runtime — fall back to plain base64url.
    }
  }
  return base64UrlFromBytes(utf8);
}

/**
 * Decode a ?blueprint= / ?blueprint-data= payload back into its raw object,
 * transparently handling both gzip-compressed and plain base64(url) JSON.
 */
export async function decodeBlueprintParam(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Blueprint data payload is empty.");
  }

  const bytes = bytesFromBase64(text);
  const jsonBytes =
    hasGzipMagic(bytes) && typeof DecompressionStream === "function"
      ? await gunzipBytes(bytes)
      : bytes;

  let json;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    throw new Error("Blueprint data payload is not valid UTF-8.");
  }

  try {
    return JSON.parse(json);
  } catch {
    throw new Error("Blueprint data payload is not valid JSON.");
  }
}

async function parseBlueprintDataParam(value, config) {
  return normalizeBlueprint(await decodeBlueprintParam(value), config);
}

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeRole(role, fallback = "global_admin") {
  const normalized = String(role || fallback)
    .trim()
    .toLowerCase();
  const aliases = {
    admin: "global_admin",
    globaladmin: "global_admin",
    global_admin: "global_admin",
    siteadmin: "site_admin",
    site_admin: "site_admin",
    supervisor: "site_admin",
  };

  return aliases[normalized] || normalized;
}

function slugify(value, fallback = "playground") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || fallback;
}

const SITE_PERMISSION_ROLES = ["viewer", "editor", "admin"];

function normalizeSitePermissions(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((permission) => {
      const user = String(permission?.user || permission?.email || "").trim();
      if (!user) {
        return null;
      }

      const role = String(permission?.role || "viewer")
        .trim()
        .toLowerCase();

      return {
        user,
        role: SITE_PERMISSION_ROLES.includes(role) ? role : "viewer",
      };
    })
    .filter(Boolean);
}

function normalizeSiteSpec(site, fallbackTitle) {
  if (!site || typeof site !== "object" || Array.isArray(site)) {
    return null;
  }

  const title = String(site.title || fallbackTitle || "").trim();
  if (!title) {
    return null;
  }

  return {
    title,
    slug: slugify(site.slug || site.title || fallbackTitle),
    summary: typeof site.summary === "string" ? site.summary : "",
    theme: String(site.theme || "default").trim(),
    isPublic: site.isPublic !== false,
    setAsDefault: site.setAsDefault === true,
    permissions: normalizeSitePermissions(site.permissions),
  };
}

function normalizeUserSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const settings = {};
  for (const [key, value] of Object.entries(input)) {
    const settingKey = String(key).trim();
    if (settingKey) {
      settings[settingKey] = value;
    }
  }
  return settings;
}

function normalizeSites(blueprint, fallbackTitle) {
  let sites = [];

  if (Array.isArray(blueprint.sites) && blueprint.sites.length > 0) {
    // Multi-site mode: setAsDefault defaults to false per entry.
    sites = blueprint.sites
      .map((site) => normalizeSiteSpec(site))
      .filter(Boolean);
  } else if (
    blueprint.site &&
    typeof blueprint.site === "object" &&
    !Array.isArray(blueprint.site)
  ) {
    // Single-site mode: keep the historical setAsDefault default of true.
    const single = normalizeSiteSpec(blueprint.site, fallbackTitle);
    if (single) {
      single.setAsDefault = blueprint.site.setAsDefault !== false;
      sites = [single];
    }
  }

  // Reject duplicate slugs so site/permission assignments stay unambiguous.
  const seenSlugs = new Set();
  for (const site of sites) {
    if (seenSlugs.has(site.slug)) {
      throw new Error(
        `Blueprint sites cannot include duplicate slug "${site.slug}".`,
      );
    }
    seenSlugs.add(site.slug);
  }

  // Guarantee exactly one default site so items without an explicit site land
  // somewhere predictable.
  if (sites.length > 0 && !sites.some((site) => site.setAsDefault)) {
    sites[0].setAsDefault = true;
  }

  return sites;
}

function normalizeAddonSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "bundled" };
  }

  const type = String(
    input.type ||
      (input.url ? "url" : "") ||
      (input.slug ? "omeka.org" : "") ||
      "bundled",
  )
    .trim()
    .toLowerCase();

  if (type === "bundled") {
    return { type };
  }

  if (type === "url") {
    const url = absolutizeUrl(input.url || "");
    if (!url) {
      throw new Error("Blueprint addon source.type='url' requires source.url.");
    }
    return { type, url };
  }

  if (type === "omeka.org") {
    const slug = String(input.slug || "").trim();
    if (!slug) {
      throw new Error(
        "Blueprint addon source.type='omeka.org' requires source.slug.",
      );
    }
    return { type, slug };
  }

  throw new Error(`Unsupported blueprint addon source type "${type}".`);
}

// Normalize the optional `assets` overlay list on an add-on entry. Each asset
// is an extra ZIP unpacked into a path relative to the installed add-on (used,
// for example, to drop the shared static editor bundle into the module).
function normalizeAddonAssets(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((asset) => {
      const url = absolutizeUrl(asset?.url || "");
      const destination = String(asset?.destination || "").trim();
      if (!url || !destination) {
        return null;
      }
      return { url, destination };
    })
    .filter(Boolean);
}

function normalizeAddonCollection(input, kind) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set();
  return input
    .map((entry) => {
      const normalized = {
        name: String(entry?.name || entry || "").trim(),
        source: normalizeAddonSource(entry?.source),
      };

      const assets = normalizeAddonAssets(entry?.assets);
      if (assets.length) {
        normalized.assets = assets;
      }

      if (kind === "module") {
        normalized.state =
          String(entry?.state || "activate")
            .trim()
            .toLowerCase() || "activate";
      }

      if (!normalized.name) {
        return null;
      }

      if (
        /[\\/]/u.test(normalized.name) ||
        normalized.name === "." ||
        normalized.name === ".."
      ) {
        throw new Error(
          `Blueprint ${kind} name "${normalized.name}" must be a single path segment.`,
        );
      }

      const dedupeKey = normalized.name.toLowerCase();
      if (seen.has(dedupeKey)) {
        throw new Error(
          `Blueprint ${kind}s cannot include duplicate entry "${normalized.name}".`,
        );
      }
      seen.add(dedupeKey);

      return normalized;
    })
    .filter(Boolean);
}

export function getBlueprintSchemaUrl() {
  return resolveProjectUrl(
    "assets/blueprints/blueprint-schema.json",
  ).toString();
}

export function buildDefaultBlueprint(config) {
  return {
    $schema: getBlueprintSchemaUrl(),
    meta: {
      title: `${config.siteTitle} Blueprint`,
      author: "omeka-s-playground",
      description: "Default Omeka S Playground blueprint.",
    },
    preferredVersions: {
      php:
        config.defaults?.phpVersion ||
        config.runtimes?.find((runtime) => runtime.default)?.phpVersion ||
        config.runtimes?.[0]?.phpVersion ||
        DEFAULT_PHP_VERSION,
      omeka:
        config.defaults?.omekaVersion ||
        config.runtimes?.find((runtime) => runtime.default)?.omekaVersion ||
        config.runtimes?.[0]?.omekaVersion ||
        DEFAULT_OMEKA_VERSION,
    },
    debug: {
      enabled: false,
    },
    landingPage: "/admin",
    siteOptions: {
      title: config.siteTitle,
      locale: config.locale,
      timezone: config.timezone,
    },
    login: {
      email: config.admin.email,
      password: config.admin.password,
    },
    users: [
      {
        username: config.admin.username,
        email: config.admin.email,
        password: config.admin.password,
        role: "global_admin",
        isActive: true,
      },
    ],
    themes: [],
    modules: [],
    itemSets: [
      {
        title: "Playground Collection",
        description:
          "Default collection created from the Omeka S Playground blueprint.",
      },
    ],
    items: [
      {
        title: "Openverse Sample Image",
        description:
          "Sample item created automatically from the default blueprint.",
        creator: "Openverse",
        itemSets: ["Playground Collection"],
        media: [
          {
            type: "url",
            url: "./assets/samples/playground-sample.png",
            title: "Playground sample image",
          },
        ],
      },
    ],
  };
}

export function normalizeBlueprint(input, config) {
  const blueprint =
    input && typeof input === "object" && !Array.isArray(input)
      ? structuredClone(input)
      : {};
  const fallback = buildDefaultBlueprint(config);
  const users =
    Array.isArray(blueprint.users) && blueprint.users.length > 0
      ? blueprint.users
      : fallback.users;

  const normalizedUsers = users.map((user, index) => {
    const fallbackUser = index === 0 ? fallback.users[0] : {};
    const email = String(user?.email || fallbackUser.email || "").trim();
    const username = String(
      user?.username ||
        user?.name ||
        fallbackUser.username ||
        email.split("@")[0] ||
        `user-${index + 1}`,
    ).trim();
    const password = String(
      user?.password || fallbackUser.password || "",
    ).trim();

    if (!email || !password) {
      throw new Error(
        `Blueprint user at index ${index} must include email and password.`,
      );
    }

    return {
      username,
      email,
      password,
      role: normalizeRole(
        user?.role,
        index === 0 ? "global_admin" : "researcher",
      ),
      isActive: user?.isActive !== false,
      settings: normalizeUserSettings(user?.settings),
    };
  });

  const sites = normalizeSites(blueprint, fallback.siteOptions.title);
  // `site` (singular) is kept for backward compatibility and resolves to the
  // default site (or the first one) so existing consumers keep working.
  const activeSite =
    sites.find((site) => site.setAsDefault) || sites[0] || null;

  return {
    $schema:
      typeof blueprint.$schema === "string"
        ? blueprint.$schema
        : fallback.$schema,
    meta: {
      title: blueprint.meta?.title || fallback.meta.title,
      author: blueprint.meta?.author || fallback.meta.author,
      description: blueprint.meta?.description || fallback.meta.description,
    },
    preferredVersions: {
      php: blueprint.preferredVersions?.php || fallback.preferredVersions.php,
      omeka:
        resolveOmekaVersion(blueprint.preferredVersions?.omeka) ||
        fallback.preferredVersions.omeka,
    },
    debug: {
      enabled: blueprint.debug?.enabled === true,
    },
    landingPage: normalizePath(
      blueprint.landingPage || blueprint.landingPath || fallback.landingPage,
      fallback.landingPage,
    ),
    siteOptions: {
      title: blueprint.siteOptions?.title || fallback.siteOptions.title,
      locale: blueprint.siteOptions?.locale || fallback.siteOptions.locale,
      timezone:
        blueprint.siteOptions?.timezone || fallback.siteOptions.timezone,
    },
    login: {
      email: blueprint.login?.email || normalizedUsers[0].email,
      password: blueprint.login?.password || normalizedUsers[0].password,
    },
    users: normalizedUsers,
    site: activeSite,
    sites,
    themes: normalizeAddonCollection(blueprint.themes, "theme"),
    modules: normalizeAddonCollection(blueprint.modules, "module"),
    itemSets: Array.isArray(blueprint.itemSets)
      ? blueprint.itemSets
          .map((itemSet) => ({
            title: String(itemSet?.title || "").trim(),
            description:
              typeof itemSet?.description === "string"
                ? itemSet.description
                : "",
          }))
          .filter((itemSet) => itemSet.title)
      : [],
    items: Array.isArray(blueprint.items)
      ? blueprint.items
          .map((item) => ({
            title: String(item?.title || "").trim(),
            description:
              typeof item?.description === "string" ? item.description : "",
            creator: typeof item?.creator === "string" ? item.creator : "",
            itemSets: Array.isArray(item?.itemSets)
              ? item.itemSets
                  .map((entry) => String(entry || "").trim())
                  .filter(Boolean)
              : [],
            sites: Array.isArray(item?.sites)
              ? item.sites
                  .map((entry) => slugify(String(entry || ""), ""))
                  .filter(Boolean)
              : [],
            media: Array.isArray(item?.media)
              ? item.media
                  .map((media) => ({
                    type: String(media?.type || "url")
                      .trim()
                      .toLowerCase(),
                    url: absolutizeUrl(media?.url || media?.source || ""),
                    title: typeof media?.title === "string" ? media.title : "",
                    altText:
                      typeof media?.altText === "string" ? media.altText : "",
                  }))
                  .filter((media) => media.url)
              : [],
          }))
          .filter((item) => item.title)
      : [],
  };
}

export function buildEffectivePlaygroundConfig(config, blueprint) {
  const normalized = normalizeBlueprint(blueprint, config);
  const primaryUser = normalized.users[0];

  return {
    ...config,
    siteTitle: normalized.siteOptions.title,
    locale: normalized.siteOptions.locale,
    timezone: normalized.siteOptions.timezone,
    landingPath: normalized.landingPage,
    debug: normalized.debug,
    admin: {
      username: primaryUser.username,
      email: normalized.login.email || primaryUser.email,
      password: normalized.login.password || primaryUser.password,
    },
  };
}

export function exportBlueprintPayload(config, blueprint) {
  return normalizeBlueprint(blueprint, config);
}

export function saveActiveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.setItem(
    getBlueprintStorageKey(scopeId),
    JSON.stringify(blueprint),
  );
}

export function loadActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return null;
  }

  const raw = window.sessionStorage.getItem(getBlueprintStorageKey(scopeId));
  return raw ? JSON.parse(raw) : null;
}

export function clearActiveBlueprint(scopeId) {
  if (!hasWindow()) {
    return;
  }

  window.sessionStorage.removeItem(getBlueprintStorageKey(scopeId));
}

export async function resolveBlueprintForShell(scopeId, config) {
  if (!hasWindow()) {
    return buildDefaultBlueprint(config);
  }

  const url = new URL(window.location.href);

  // 1. ?blueprint= (inline base64/JSON, or remote URL for backward compat)
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const looksLikeUrl =
      blueprintParam.startsWith("http://") ||
      blueprintParam.startsWith("https://");
    if (looksLikeUrl) {
      const response = await fetch(
        new URL(blueprintParam, window.location.href),
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          `Unable to load blueprint from ${blueprintParam}: ${response.status}`,
        );
      }
      const payload = normalizeBlueprint(await response.json(), config);
      saveActiveBlueprint(scopeId, payload);
      return payload;
    }
    const payload = await parseBlueprintDataParam(blueprintParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 2. ?blueprint-url= (remote URL — primary, matches moodle-playground)
  const blueprintUrlParam = url.searchParams.get("blueprint-url");
  if (blueprintUrlParam) {
    const response = await fetch(
      new URL(blueprintUrlParam, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(
        `Unable to load blueprint from ${blueprintUrlParam}: ${response.status}`,
      );
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // 3. ?blueprint-data= (legacy alias for ?blueprint=, kept for backward compat)
  const blueprintDataParam = url.searchParams.get("blueprint-data");
  if (blueprintDataParam) {
    console.warn(
      "[blueprint] ?blueprint-data= is deprecated, use ?blueprint= instead.",
    );
    const payload = await parseBlueprintDataParam(blueprintDataParam, config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  // sessionStorage blueprints are not reloaded on bare URL navigations —
  // the ephemeral runtime should boot clean.

  if (config.defaultBlueprintUrl) {
    const response = await fetch(
      new URL(config.defaultBlueprintUrl, window.location.href),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`Unable to load default blueprint: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  const payload = buildDefaultBlueprint(config);
  saveActiveBlueprint(scopeId, payload);
  return payload;
}

export function parseImportedBlueprintPayload(rawPayload, config) {
  if (rawPayload?.version === SNAPSHOT_VERSION) {
    return {
      type: "snapshot",
      runtimeId: rawPayload.runtimeId,
      path: normalizePath(rawPayload.path, config.landingPath || "/"),
    };
  }

  return {
    type: "blueprint",
    blueprint: normalizeBlueprint(rawPayload, config),
  };
}
