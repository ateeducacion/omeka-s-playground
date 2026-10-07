import {
  BlueprintImportError,
  BlueprintSchemaError,
  fetchJsonDocument,
  parseJsonc,
  resolveBlueprintImports,
  withoutImportReferences,
} from "./blueprint-imports.js";
import {
  DEFAULT_OMEKA_VERSION,
  DEFAULT_PHP_VERSION,
  resolveOmekaVersion,
} from "./omeka-versions.js";
import { SNAPSHOT_VERSION } from "./protocol.js";

const BLUEPRINT_KEY_PREFIX = "omeka-playground:blueprint";

// The shared Omeka S blueprint format (omeka-s-contrib/omeka-s-blueprints):
// the floating v0 schema, which never gets breaking changes. Blueprints in the
// earlier Playground format (siteOptions, login, landingPage, site, object
// sources, modules[].assets) keep working as legacy aliases.
export const SHARED_BLUEPRINT_SCHEMA_URL =
  "https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0/blueprint-schema.json";

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
    return parseJsonc(json);
  } catch {
    throw new Error("Blueprint data payload is not valid JSON.");
  }
}

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

// Any role id is valid (modules register their own, e.g. guest). The aliases
// below are a Playground convenience, not part of the shared format.
function normalizeRole(role, fallback = "global_admin") {
  const value = String(role || fallback).trim();
  const normalized = value.toLowerCase();
  const aliases = {
    admin: "global_admin",
    globaladmin: "global_admin",
    global_admin: "global_admin",
    siteadmin: "site_admin",
    site_admin: "site_admin",
    supervisor: "site_admin",
  };

  return aliases[normalized] || value;
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

// Valid PHP constant names: start with a letter or underscore, then letters,
// digits, or underscores. Matches the blueprint schema's propertyNames pattern.
const PHP_CONSTANT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Keep only well-formed `NAME -> scalar` entries so the engine can safely emit
// PHP `define()` calls. Any blueprint (not the engine) decides which PHP
// constants to define; invalid names and non-scalar values are dropped.
function normalizePhpConstants(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const constants = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key).trim();
    if (!PHP_CONSTANT_NAME_PATTERN.test(name)) {
      continue;
    }
    if (typeof value === "boolean" || typeof value === "string") {
      constants[name] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      constants[name] = value;
    }
  }
  return constants;
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

  // A repeated slug follows "last one wins", as the other lists do.
  sites = dedupeLastWins(sites, "sites");

  // Guarantee exactly one default site so items without an explicit site land
  // somewhere predictable.
  if (sites.length > 0 && !sites.some((site) => site.setAsDefault)) {
    sites[0].setAsDefault = true;
  }

  return sites;
}

function githubArchiveUrl(owner, repo, ref) {
  return `https://github.com/${owner}/${repo}/archive/${encodeURI(ref)}.zip`;
}

// A shared-format source string: a ZIP URL, a GitHub repository URL or
// gh:owner/repo[#ref]. GitHub repositories become archive downloads of the ref,
// the version or HEAD. Other git hosts and schemes are rejected.
function normalizeAddonSourceString(input, version) {
  const text = input.trim();
  if (!text) {
    return { type: "bundled" };
  }

  const [location, hashRef = ""] = text.split("#", 2);
  const ref = hashRef || version || "HEAD";
  const shortRepo = /^gh:([\w.-]+)\/([\w.-]+)$/u.exec(location);
  if (shortRepo) {
    return {
      type: "url",
      url: githubArchiveUrl(shortRepo[1], shortRepo[2], ref),
    };
  }

  const githubRepo =
    /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/u.exec(
      location,
    );
  if (githubRepo) {
    return {
      type: "url",
      url: githubArchiveUrl(githubRepo[1], githubRepo[2], ref),
    };
  }

  if (/\.git$/u.test(location) || /^[a-z][a-z0-9+.-]*:(?!\/\/)/iu.test(text)) {
    throw new Error(
      `Blueprint add-on source "${text}" is not supported by the Playground: use a ZIP URL, a GitHub repository URL or gh:owner/repo.`,
    );
  }

  return { type: "url", url: absolutizeUrl(text) };
}

function normalizeAddonSource(input, version = "") {
  if (typeof input === "string") {
    return normalizeAddonSourceString(input, version);
  }

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

// What identifies an entry of each list for "last one wins" (shared spec): a
// later entry with the same identity (case-insensitive) replaces the earlier
// one and takes its position at the end, as in Omeka-S-Cli. Which field is the
// identity, and replace vs. merge, are still open in the shared spec
// (omeka-s-contrib/omeka-s-blueprints#10); vocabularies use namespaceUri, the
// identity Omeka S itself enforces, where Omeka-S-Cli currently uses prefix.
export const ENTRY_IDENTITY = {
  modules: (entry) => entry.name,
  themes: (entry) => entry.name,
  files: (entry) => entry.destination,
  vocabularies: (entry) => entry.namespaceUri,
  resourceTemplates: (entry) => entry.label || entry.source,
  users: (entry) => entry?.email,
  sites: (entry) => entry.slug,
  itemSets: (entry) => entry.title,
  items: (entry) => entry.title,
};

// A warning is logged only when the override changes the entry.
function dedupeLastWins(entries, key) {
  const byId = new Map();
  const loose = [];
  for (const entry of entries) {
    const id = String(ENTRY_IDENTITY[key](entry) ?? "")
      .trim()
      .toLowerCase();
    if (!id) {
      loose.push(entry);
      continue;
    }
    const previous = byId.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
      console.warn(
        `[blueprint] ${key} "${id}" is declared more than once; the later definition overrides the earlier one.`,
      );
    }
    byId.delete(id);
    byId.set(id, entry);
  }
  return [...byId.values(), ...loose];
}

function normalizeAddonCollection(input, kind) {
  if (!Array.isArray(input)) {
    return [];
  }
  return dedupeLastWins(
    input.map((entry) => normalizeAddonEntry(entry, kind)).filter(Boolean),
    `${kind}s`,
  );
}

function normalizeAddonEntry(entry, kind) {
  const version = String(entry?.version || "").trim();
  const normalized = {
    name: String(entry?.name || entry || "").trim(),
    source: normalizeAddonSource(entry?.source, version),
  };

  if (version) {
    normalized.version = version;
  }

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

  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Root `files`: files placed in the Omeka S installation. The destination must
// stay inside the Omeka S root (relative, no '..' segment), as in the schema.
function normalizeFiles(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter(isPlainObject).map((file) => {
    const destination = String(file.destination || "").trim();
    const segments = destination.replaceAll("\\", "/").split("/");
    if (
      !destination ||
      segments[0] === "" ||
      /^[A-Za-z]:/u.test(destination) ||
      segments.includes("..")
    ) {
      throw new Error(
        `Blueprint file destination "${destination}" must be a path inside the Omeka S root.`,
      );
    }
    const source = absolutizeUrl(file.source || "");
    if (!source) {
      throw new Error(`Blueprint file "${destination}" requires a source.`);
    }
    return { source, destination, extract: file.extract === true };
  });
}

function requiredString(entry, field, what) {
  const value = String(entry[field] ?? "").trim();
  if (!value) {
    throw new Error(`Blueprint ${what} requires "${field}".`);
  }
  return value;
}

const VOCABULARY_OPTIONAL_FIELDS = [
  "comment",
  "format",
  "lang",
  "labelProperty",
  "commentProperty",
];

// RDF vocabularies, imported with Omeka's RdfImporter after the modules.
function normalizeVocabularies(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter(isPlainObject).map((entry) => {
    const what = `vocabulary "${entry.prefix || entry.namespaceUri || ""}"`;
    const vocabulary = {
      source: absolutizeUrl(requiredString(entry, "source", what)),
      namespaceUri: requiredString(entry, "namespaceUri", what),
      prefix: requiredString(entry, "prefix", what),
      label: requiredString(entry, "label", what),
    };
    for (const field of VOCABULARY_OPTIONAL_FIELDS) {
      if (typeof entry[field] === "string" && entry[field].trim()) {
        vocabulary[field] = entry[field].trim();
      }
    }
    return vocabulary;
  });
}

// Resource-template JSON exports, imported after the vocabularies.
function normalizeResourceTemplates(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter(isPlainObject).map((entry) => {
    const template = {
      source: absolutizeUrl(
        requiredString(entry, "source", "resource template"),
      ),
    };
    if (typeof entry.label === "string" && entry.label.trim()) {
      template.label = entry.label.trim();
    }
    template.ignoreDeps = entry.ignoreDeps === true;
    return template;
  });
}

// `$import` entries are resolved when the blueprint is loaded
// (blueprint-imports.js); one that reaches the normalizer was never resolved,
// for example in a key that does not accept imports.
function rejectUnresolvedImports(blueprint) {
  for (const [key, value] of Object.entries(blueprint)) {
    if (key.startsWith("x-") || !value || typeof value !== "object") {
      continue;
    }
    const entries = Array.isArray(value) ? value : [value];
    const index = entries.findIndex(
      (entry) => isPlainObject(entry) && "$import" in entry,
    );
    if (index !== -1) {
      throw new Error(
        `Blueprint ${key} has an unresolved $import "${entries[index].$import}": imports are only resolved in lists that accept them, when the blueprint is loaded.`,
      );
    }
  }
}

// Global settings: a map of setting id => value, or a list of maps merged in
// order (later maps win), once their `$import` entries are resolved.
function normalizeSettings(input) {
  const maps = Array.isArray(input) ? input : [input];
  const settings = {};
  for (const map of maps) {
    if (!isPlainObject(map)) {
      continue;
    }
    for (const [key, value] of Object.entries(map)) {
      const settingKey = String(key).trim();
      if (settingKey) {
        settings[settingKey] = value;
      }
    }
  }
  return settings;
}

export function buildDefaultBlueprint(config) {
  return {
    $schema: SHARED_BLUEPRINT_SCHEMA_URL,
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
    install: {
      title: config.siteTitle,
      locale: config.locale,
      timezone: config.timezone,
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
    "x-playground": {
      landingPage: "/admin",
      debug: { enabled: false },
    },
  };
}

// install.admin is the first global administrator: it goes first in the user
// list, merged with a user that has the same email.
function withInstallAdmin(users, admin) {
  if (!isPlainObject(admin) || !admin.email) {
    return users;
  }
  const email = String(admin.email).trim();
  const same = users.find((user) => user?.email === email) || {};
  const first = {
    ...same,
    email,
    username: admin.name || same.username || same.name,
    password: admin.password || same.password,
    role: "global_admin",
  };
  return [first, ...users.filter((user) => user?.email !== email)];
}

export function normalizeBlueprint(input, config) {
  const blueprint =
    input && typeof input === "object" && !Array.isArray(input)
      ? structuredClone(input)
      : {};
  rejectUnresolvedImports(blueprint);
  const fallback = buildDefaultBlueprint(config);
  // Shared format first, then the legacy Playground keys.
  const install = isPlainObject(blueprint.install) ? blueprint.install : {};
  const legacyInstall = isPlainObject(blueprint.siteOptions)
    ? blueprint.siteOptions
    : {};
  const runtime = isPlainObject(blueprint["x-playground"])
    ? blueprint["x-playground"]
    : {};
  const login = isPlainObject(runtime.login)
    ? runtime.login
    : isPlainObject(blueprint.login)
      ? blueprint.login
      : install.admin || {};
  const blueprintUsers = withInstallAdmin(
    Array.isArray(blueprint.users)
      ? dedupeLastWins(blueprint.users, "users")
      : [],
    install.admin,
  );
  const users = blueprintUsers.length > 0 ? blueprintUsers : fallback.users;

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
    // The password is optional in the shared format: any user without one
    // gets the configured admin password, as install.admin does.
    const password = String(
      user?.password || fallback.users[0].password || "",
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

  const sites = normalizeSites(blueprint, fallback.install.title);
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
      enabled: (runtime.debug ?? blueprint.debug)?.enabled === true,
    },
    phpConstants: normalizePhpConstants(
      runtime.phpConstants ?? blueprint.phpConstants,
    ),
    landingPage: normalizePath(
      runtime.landingPage ||
        blueprint.landingPage ||
        blueprint.landingPath ||
        fallback["x-playground"].landingPage,
      fallback["x-playground"].landingPage,
    ),
    siteOptions: {
      title: install.title || legacyInstall.title || fallback.install.title,
      locale: install.locale || legacyInstall.locale || fallback.install.locale,
      timezone:
        install.timezone || legacyInstall.timezone || fallback.install.timezone,
    },
    login: {
      email: login.email || normalizedUsers[0].email,
      password: login.password || normalizedUsers[0].password,
    },
    users: normalizedUsers,
    site: activeSite,
    sites,
    themes: normalizeAddonCollection(blueprint.themes, "theme"),
    modules: normalizeAddonCollection(blueprint.modules, "module"),
    files: dedupeLastWins(normalizeFiles(blueprint.files), "files"),
    vocabularies: dedupeLastWins(
      normalizeVocabularies(blueprint.vocabularies),
      "vocabularies",
    ),
    resourceTemplates: dedupeLastWins(
      normalizeResourceTemplates(blueprint.resourceTemplates),
      "resourceTemplates",
    ),
    settings: normalizeSettings(blueprint.settings),
    itemSets: Array.isArray(blueprint.itemSets)
      ? dedupeLastWins(blueprint.itemSets.filter(isPlainObject), "itemSets")
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
      ? dedupeLastWins(blueprint.items.filter(isPlainObject), "items")
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
    phpConstants: normalized.phpConstants,
    admin: {
      username: primaryUser.username,
      email: normalized.login.email || primaryUser.email,
      password: normalized.login.password || primaryUser.password,
    },
  };
}

function exportAddon(addon) {
  const entry = { name: addon.name };
  if (addon.state) {
    entry.state = addon.state;
  }
  if (addon.version) {
    entry.version = addon.version;
  }
  // bundled and omeka.org sources resolve by name in the shared format
  if (addon.source?.type === "url") {
    entry.source = addon.source.url;
  }
  return entry;
}

// Legacy modules[].assets become root files, extracted into the add-on.
function exportFiles(normalized) {
  const assetFiles = (addons, dir) =>
    addons.flatMap((addon) =>
      (addon.assets || []).map((asset) => ({
        source: asset.url,
        destination: `${dir}/${addon.name}/${asset.destination}`,
        extract: true,
      })),
    );
  return [
    ...assetFiles(normalized.modules, "modules"),
    ...assetFiles(normalized.themes, "themes"),
    ...normalized.files,
  ];
}

/** The active blueprint in the shared format, for the editor's Export. */
export function exportBlueprintPayload(config, blueprint) {
  const normalized = normalizeBlueprint(blueprint, config);
  const [admin] = normalized.users;
  const runtime = {
    landingPage: normalized.landingPage,
    debug: normalized.debug,
  };
  if (Object.keys(normalized.phpConstants).length) {
    runtime.phpConstants = normalized.phpConstants;
  }
  if (normalized.login.email !== admin.email) {
    runtime.login = normalized.login;
  }
  const files = exportFiles(normalized);

  return {
    $schema: SHARED_BLUEPRINT_SCHEMA_URL,
    meta: normalized.meta,
    preferredVersions: normalized.preferredVersions,
    install: {
      ...normalized.siteOptions,
      admin: {
        name: admin.username,
        email: admin.email,
        password: admin.password,
      },
    },
    modules: normalized.modules.map(exportAddon),
    themes: normalized.themes.map(exportAddon),
    ...(files.length ? { files } : {}),
    ...(normalized.vocabularies.length
      ? { vocabularies: normalized.vocabularies }
      : {}),
    ...(normalized.resourceTemplates.length
      ? { resourceTemplates: normalized.resourceTemplates }
      : {}),
    settings: normalized.settings,
    users: normalized.users,
    itemSets: normalized.itemSets,
    items: normalized.items,
    sites: normalized.sites,
    "x-playground": runtime,
  };
}

export function saveActiveBlueprint(scopeId, blueprint) {
  if (!hasWindow()) {
    return;
  }

  // NOTE: the blueprint includes admin/user passwords. This is not a secret
  // leak: these are caller-authored credentials for an ephemeral in-browser
  // sandbox (no server, no shared state; blueprints may define multiple users).
  // The same values already live in the blueprint source the caller provided,
  // and per-tab sessionStorage is wiped when the tab closes. sessionStorage is
  // load-bearing beyond a simple shell -> iframe transport: on reload the remote
  // iframe re-runs bootstrapRemote() and re-reads this entry (no live shell
  // message exists then), so the blueprint must persist here to survive reloads.
  // The password must also survive to recreate blueprint-defined users (schema
  // requires a password per user, so it cannot be stripped). The CodeQL
  // "clear-text storage" finding is therefore a false positive for this threat
  // model.
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

// Blueprints that declare the shared schema ($schema of the v0 family) must
// match it; others (the earlier Playground format, or no $schema) only get
// warnings, so the legacy aliases keep working.
const SHARED_SCHEMA_URL_PATTERN =
  /^https:\/\/omeka-s-contrib\.github\.io\/omeka-s-blueprints\/schema\/v0(?:\.\d+\.\d+)?\/blueprint-schema\.json$/u;

export function declaresSharedSchema(document) {
  return SHARED_SCHEMA_URL_PATTERN.test(String(document?.$schema || ""));
}

/**
 * Load a raw blueprint document: check it against the shared schema, resolve
 * its `$import` entries (against `baseUrl`, the URL it was loaded from, when
 * there is one) and normalize it. Schema errors are BlueprintSchemaError;
 * import errors (download, cycle, invalid content) are BlueprintImportError.
 *
 * @param {object} document
 * @param {object} config
 * @param {{baseUrl?: string|null, fetchJson?: Function, schema?: {validateBlueprintSchema: Function, validateImportedDocument: Function}|null}} [options]
 */
export async function loadBlueprintDocument(document, config, options = {}) {
  const { baseUrl = null, fetchJson, schema = null } = options;
  if (!isPlainObject(document)) {
    throw new BlueprintImportError("Blueprint must be a JSON object.");
  }
  const strict = Boolean(schema) && declaresSharedSchema(document);
  if (schema) {
    const errors = schema.validateBlueprintSchema(document);
    if (errors.length && strict) {
      throw new BlueprintSchemaError(
        `Blueprint${baseUrl ? ` ${baseUrl}` : ""} does not match the shared blueprint schema: ${errors.join("; ")}`,
      );
    }
    if (errors.length) {
      console.warn(
        `[blueprint] Not valid against the shared schema (accepted as the earlier Playground format): ${errors.join("; ")}`,
      );
    }
  }
  const resolved = await resolveBlueprintImports(document, {
    baseUrl,
    fetchJson,
    validateImported: strict ? schema.validateImportedDocument : null,
  });
  return normalizeBlueprint(resolved, config);
}

async function fetchBlueprintFromUrl(href, fetchJson = fetchJsonDocument) {
  const url = new URL(href, window.location.href).toString();
  try {
    return { document: await fetchJson(url), baseUrl: url };
  } catch (error) {
    throw new Error(`Unable to load blueprint from ${href}: ${error.message}`);
  }
}

/**
 * @param {string} scopeId
 * @param {object} config
 * @param {{schema?: object|null}} [options] the shared-schema validator
 */
export async function resolveBlueprintForShell(scopeId, config, options = {}) {
  if (!hasWindow()) {
    return buildDefaultBlueprint(config);
  }

  const url = new URL(window.location.href);
  const load = async ({ document, baseUrl = null }) => {
    const payload = await loadBlueprintDocument(document, config, {
      baseUrl,
      schema: options.schema || null,
    });
    saveActiveBlueprint(scopeId, payload);
    return payload;
  };

  // 1. ?blueprint= (inline base64/JSON, or remote URL for backward compat)
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const looksLikeUrl =
      blueprintParam.startsWith("http://") ||
      blueprintParam.startsWith("https://");
    return load(
      looksLikeUrl
        ? await fetchBlueprintFromUrl(blueprintParam)
        : { document: await decodeBlueprintParam(blueprintParam) },
    );
  }

  // 2. ?blueprint-url= (remote URL — primary, matches moodle-playground)
  const blueprintUrlParam = url.searchParams.get("blueprint-url");
  if (blueprintUrlParam) {
    return load(await fetchBlueprintFromUrl(blueprintUrlParam));
  }

  // 3. ?blueprint-data= (legacy alias for ?blueprint=, kept for backward compat)
  const blueprintDataParam = url.searchParams.get("blueprint-data");
  if (blueprintDataParam) {
    console.warn(
      "[blueprint] ?blueprint-data= is deprecated, use ?blueprint= instead.",
    );
    return load({ document: await decodeBlueprintParam(blueprintDataParam) });
  }

  // sessionStorage blueprints are not reloaded on bare URL navigations —
  // the ephemeral runtime should boot clean.

  if (config.defaultBlueprintUrl) {
    return load(await fetchBlueprintFromUrl(config.defaultBlueprintUrl));
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

  // Checked here, but the raw document is what runs: the shell resolves its
  // absolute $import entries when it loads it.
  normalizeBlueprint(withoutImportReferences(rawPayload), config);
  return { type: "blueprint", blueprint: rawPayload };
}
