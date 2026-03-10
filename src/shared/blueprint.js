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

function normalizePath(path, fallback = "/") {
  if (!path || typeof path !== "string") {
    return fallback;
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeRole(role, fallback = "global_admin") {
  const normalized = String(role || fallback).trim().toLowerCase();
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

export function getBlueprintSchemaUrl() {
  return new URL("../../assets/blueprints/blueprint-schema.json", import.meta.url).toString();
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
      php: config.runtimes?.find((runtime) => runtime.default)?.phpVersionLabel || config.runtimes?.[0]?.phpVersionLabel || "8.3",
      omeka: "4.2.0",
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
        description: "Default collection created from the Omeka S Playground blueprint.",
      },
    ],
    items: [
      {
        title: "Openverse Sample Image",
        description: "Sample item created automatically from the default blueprint.",
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
  const blueprint = (input && typeof input === "object" && !Array.isArray(input))
    ? structuredClone(input)
    : {};
  const fallback = buildDefaultBlueprint(config);
  const users = Array.isArray(blueprint.users) && blueprint.users.length > 0
    ? blueprint.users
    : fallback.users;

  const normalizedUsers = users.map((user, index) => {
    const fallbackUser = index === 0 ? fallback.users[0] : {};
    const email = String(user?.email || fallbackUser.email || "").trim();
    const username = String(user?.username || user?.name || fallbackUser.username || email.split("@")[0] || `user-${index + 1}`).trim();
    const password = String(user?.password || fallbackUser.password || "").trim();

    if (!email || !password) {
      throw new Error(`Blueprint user at index ${index} must include email and password.`);
    }

    return {
      username,
      email,
      password,
      role: normalizeRole(user?.role, index === 0 ? "global_admin" : "researcher"),
      isActive: user?.isActive !== false,
    };
  });

  const activeSite = blueprint.site && typeof blueprint.site === "object"
    ? {
        title: String(blueprint.site.title || fallback.siteOptions.title).trim(),
        slug: slugify(blueprint.site.slug || blueprint.site.title || fallback.siteOptions.title),
        summary: typeof blueprint.site.summary === "string" ? blueprint.site.summary : "",
        theme: String(blueprint.site.theme || "default").trim(),
        isPublic: blueprint.site.isPublic !== false,
        setAsDefault: blueprint.site.setAsDefault !== false,
      }
    : null;

  return {
    $schema: typeof blueprint.$schema === "string" ? blueprint.$schema : fallback.$schema,
    meta: {
      title: blueprint.meta?.title || fallback.meta.title,
      author: blueprint.meta?.author || fallback.meta.author,
      description: blueprint.meta?.description || fallback.meta.description,
    },
    preferredVersions: {
      php: blueprint.preferredVersions?.php || fallback.preferredVersions.php,
      omeka: blueprint.preferredVersions?.omeka || fallback.preferredVersions.omeka,
    },
    landingPage: normalizePath(blueprint.landingPage || blueprint.landingPath || fallback.landingPage, fallback.landingPage),
    siteOptions: {
      title: blueprint.siteOptions?.title || fallback.siteOptions.title,
      locale: blueprint.siteOptions?.locale || fallback.siteOptions.locale,
      timezone: blueprint.siteOptions?.timezone || fallback.siteOptions.timezone,
    },
    login: {
      email: blueprint.login?.email || normalizedUsers[0].email,
      password: blueprint.login?.password || normalizedUsers[0].password,
    },
    users: normalizedUsers,
    site: activeSite,
    themes: Array.isArray(blueprint.themes)
      ? blueprint.themes.map((theme) => ({
          name: String(theme?.name || theme || "").trim(),
          source: theme?.source || null,
        })).filter((theme) => theme.name)
      : [],
    modules: Array.isArray(blueprint.modules)
      ? blueprint.modules.map((module) => ({
          name: String(module?.name || module || "").trim(),
          source: module?.source || null,
          state: String(module?.state || "activate").trim().toLowerCase(),
        })).filter((module) => module.name)
      : [],
    itemSets: Array.isArray(blueprint.itemSets)
      ? blueprint.itemSets.map((itemSet) => ({
          title: String(itemSet?.title || "").trim(),
          description: typeof itemSet?.description === "string" ? itemSet.description : "",
        })).filter((itemSet) => itemSet.title)
      : [],
    items: Array.isArray(blueprint.items)
      ? blueprint.items.map((item) => ({
          title: String(item?.title || "").trim(),
          description: typeof item?.description === "string" ? item.description : "",
          creator: typeof item?.creator === "string" ? item.creator : "",
          itemSets: Array.isArray(item?.itemSets)
            ? item.itemSets.map((entry) => String(entry || "").trim()).filter(Boolean)
            : [],
          media: Array.isArray(item?.media)
            ? item.media.map((media) => ({
                type: String(media?.type || "url").trim().toLowerCase(),
                url: absolutizeUrl(media?.url || media?.source || ""),
                title: typeof media?.title === "string" ? media.title : "",
                altText: typeof media?.altText === "string" ? media.altText : "",
              })).filter((media) => media.url)
            : [],
        })).filter((item) => item.title)
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

  window.sessionStorage.setItem(getBlueprintStorageKey(scopeId), JSON.stringify(blueprint));
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

  const stored = loadActiveBlueprint(scopeId);
  if (stored) {
    return normalizeBlueprint(stored, config);
  }

  const url = new URL(window.location.href);
  const blueprintParam = url.searchParams.get("blueprint");
  if (blueprintParam) {
    const response = await fetch(new URL(blueprintParam, window.location.href), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unable to load blueprint from ${blueprintParam}: ${response.status}`);
    }
    const payload = normalizeBlueprint(await response.json(), config);
    saveActiveBlueprint(scopeId, payload);
    return payload;
  }

  if (config.defaultBlueprintUrl) {
    const response = await fetch(new URL(config.defaultBlueprintUrl, window.location.href), { cache: "no-store" });
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
