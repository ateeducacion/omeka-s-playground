// `$import` resolution for the shared Omeka S blueprint format.
//
// A list entry `{ "$import": "<url>" }` is replaced in place by the entries of
// the referenced document: a list, or a single entry. Imported documents may
// import further documents. References resolve against the document that
// contains them (RFC 3986), as the relative `source` of `files`,
// `vocabularies` and `resourceTemplates` entries do. A document without a URL
// (an inline ?blueprint= payload, an uploaded file, the editor) can only use
// absolute references. Entry identity and "last one wins" are applied later,
// by normalizeBlueprint(), so they also hold for blueprints without imports.

// Keys whose entries may be `$import` references: the lists of the shared
// schema, plus `sites`, which Omeka-S-Cli (0.18) resolves too.
const LIST_KEYS = [
  "modules",
  "themes",
  "files",
  "vocabularies",
  "resourceTemplates",
  "users",
  "sites",
  "itemSets",
  "items",
];

// Entry fields that hold a path or URL relative to the declaring document. For
// add-ons only a path (a local ZIP release) is, not a URL or gh:owner/repo.
const ASSET_FIELDS = {
  modules: "source",
  themes: "source",
  files: "source",
  vocabularies: "source",
  resourceTemplates: "source",
};
const ADDON_KEYS = ["modules", "themes"];

// An absolute filesystem path (POSIX, backslash, Windows drive) or a file: URL,
// which a blueprint may not reference (as in Omeka-S-Cli).
const ABSOLUTE_PATH = /^(?:\/|\\|[A-Za-z]:[\\/]|file:)/iu;
// A URI scheme of two characters or more (so not a Windows drive letter).
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/u;

// Bound on nested imports, on top of the cycle check.
const MAX_IMPORT_DEPTH = 16;

export class BlueprintImportError extends Error {
  name = "BlueprintImportError";
}

export class BlueprintSchemaError extends Error {
  name = "BlueprintSchemaError";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReference(entry) {
  return isPlainObject(entry) && "$import" in entry;
}

/**
 * Resolve every `$import` of a blueprint document into a single, inlined
 * blueprint. Relative asset sources of inline entries are resolved against
 * `baseUrl` when there is one; imported entries always resolve against the
 * document that declares them.
 *
 * @param {object} document The raw blueprint.
 * @param {{baseUrl?: string|null, fetchJson?: Function, validateImported?: Function|null}} [options]
 *   `fetchJson(url)` returns the parsed JSON of a URL; `validateImported(key,
 *   document)` returns the schema errors of an imported document.
 */
export async function resolveBlueprintImports(document, options = {}) {
  const {
    baseUrl = null,
    fetchJson = fetchJsonDocument,
    validateImported = null,
  } = options;
  if (!isPlainObject(document)) {
    throw new BlueprintImportError("Blueprint must be a JSON object.");
  }
  const root = baseUrl ? stripHash(baseUrl) : null;
  const context = { fetchJson, validateImported, chain: root ? [root] : [] };
  const blueprint = { ...document };

  for (const key of LIST_KEYS) {
    if (Array.isArray(blueprint[key])) {
      blueprint[key] = await resolveList(blueprint[key], key, root, context);
    }
  }
  if (Array.isArray(blueprint.settings)) {
    blueprint.settings = await resolveSettingsList(
      blueprint.settings,
      root,
      context,
    );
  }
  return blueprint;
}

/**
 * Turn a reference into an absolute http(s) URL. GitHub/GitLab file
 * references (gh:owner/repo[@ref]:path, gl:group/repo[@ref]:path, "blob" page
 * URLs) become their raw download URLs, as in Omeka-S-Cli.
 */
export function resolveReference(reference, baseUrl) {
  const text = String(reference ?? "").trim();
  if (!text) {
    throw new BlueprintImportError("An $import reference cannot be empty.");
  }
  if (ABSOLUTE_PATH.test(text)) {
    throw new BlueprintImportError(
      `"${text}" is an absolute path or a file: URL; use a path relative to the blueprint or a URL.`,
    );
  }
  const raw = toRawUrl(text);
  let url;
  try {
    url = raw
      ? new URL(raw)
      : baseUrl
        ? new URL(text, toRawUrl(baseUrl) || baseUrl)
        : new URL(text);
  } catch {
    throw new BlueprintImportError(
      `"${text}" cannot be resolved: a relative reference needs a blueprint loaded from a URL (?blueprint-url=), and this one has none.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlueprintImportError(
      `"${text}" uses the unsupported scheme "${url.protocol}"; use an http(s) URL or a path relative to the blueprint.`,
    );
  }
  url.hash = "";
  return url.toString();
}

/**
 * A copy of the document without its `$import` entries, for the synchronous
 * checks of the editor. Throws if a reference could never be resolved.
 */
export function withoutImportReferences(document) {
  if (!isPlainObject(document)) {
    return document;
  }
  const copy = { ...document };
  for (const key of [...LIST_KEYS, "settings"]) {
    if (Array.isArray(copy[key])) {
      copy[key] = copy[key].filter((entry) => {
        if (isReference(entry)) {
          resolveReference(entry.$import, null);
          return false;
        }
        return true;
      });
    }
  }
  return copy;
}

async function resolveList(list, key, documentUrl, context) {
  const resolved = [];
  for (const entry of list) {
    if (!isReference(entry)) {
      resolved.push(resolveAssetField(entry, key, documentUrl));
      continue;
    }
    const { url, data } = await importDocument(
      entry,
      key,
      documentUrl,
      context,
    );
    const entries = Array.isArray(data) ? data : [data];
    context.chain.push(url);
    try {
      resolved.push(...(await resolveList(entries, key, url, context)));
    } finally {
      context.chain.pop();
    }
  }
  return resolved;
}

// settings: a list of maps and references, merged in order by the normalizer;
// an imported document is a map or such a list.
async function resolveSettingsList(list, documentUrl, context) {
  const resolved = [];
  for (const entry of list) {
    if (!isReference(entry)) {
      resolved.push(entry);
      continue;
    }
    const { url, data } = await importDocument(
      entry,
      "settings",
      documentUrl,
      context,
    );
    context.chain.push(url);
    try {
      resolved.push(
        ...(Array.isArray(data)
          ? await resolveSettingsList(data, url, context)
          : [data]),
      );
    } finally {
      context.chain.pop();
    }
  }
  return resolved;
}

async function importDocument(entry, key, documentUrl, context) {
  const where = documentUrl ? ` in ${documentUrl}` : "";
  let url;
  try {
    url = resolveReference(entry.$import, documentUrl);
  } catch (error) {
    throw new BlueprintImportError(
      `Blueprint ${key} $import${where}: ${error.message}`,
    );
  }
  if (context.chain.includes(url)) {
    throw new BlueprintImportError(
      `Circular $import: ${[...context.chain, url].join(" -> ")}`,
    );
  }
  if (context.chain.length >= MAX_IMPORT_DEPTH) {
    throw new BlueprintImportError(
      `Blueprint $import of ${url}${where} exceeds the maximum nesting depth (${MAX_IMPORT_DEPTH}).`,
    );
  }

  let data;
  try {
    data = await context.fetchJson(url);
  } catch (error) {
    throw new BlueprintImportError(
      `Unable to import ${url} (${key}${where}): ${error.message}`,
    );
  }
  if (!isPlainObject(data) && !Array.isArray(data)) {
    throw new BlueprintImportError(
      `Imported ${key} document ${url} must be a JSON list or object.`,
    );
  }
  if (context.validateImported) {
    const document = key === "settings" || Array.isArray(data) ? data : [data];
    const errors = context.validateImported(key, document);
    if (errors.length) {
      throw new BlueprintSchemaError(
        `Imported ${key} document ${url} does not match the shared blueprint schema: ${errors.join("; ")}`,
      );
    }
  }
  return { url, data };
}

function resolveAssetField(entry, key, documentUrl) {
  const field = ASSET_FIELDS[key];
  const value = isPlainObject(entry) ? entry[field] : undefined;
  if (!field || !documentUrl || typeof value !== "string" || !value.trim()) {
    return entry;
  }
  if (ADDON_KEYS.includes(key) && !isAddonPath(value)) {
    return entry;
  }
  try {
    return { ...entry, [field]: resolveReference(value, documentUrl) };
  } catch (error) {
    throw new BlueprintImportError(
      `Blueprint ${key} ${field} in ${documentUrl}: ${error.message}`,
    );
  }
}

// Whether an add-on source is a path (a local ZIP release) rather than a URL,
// a git address or a scheme-prefixed reference such as gh:owner/repo.
function isAddonPath(value) {
  const text = value.trim();
  return (
    ABSOLUTE_PATH.test(text) ||
    (!URI_SCHEME.test(text) && !text.startsWith("git@"))
  );
}

function stripHash(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

const GITHUB_BLOB = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/u;
const GITHUB_SHORT = /^gh:([^/@:]+)\/([^/@:]+)(?:@([^:]+))?:(.+)$/u;
const GITLAB_BLOB = /^(https?:\/\/[^/]+\/.+)\/-\/blob\/(.+)$/u;
const GITLAB_SHORT = /^gl:([^@:]+)(?:@([^:]+))?:(.+)$/u;

function toRawUrl(reference) {
  const page = reference.replace(/#.*$/u, "");
  let match = GITHUB_BLOB.exec(page);
  if (match) {
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
  }
  match = GITHUB_SHORT.exec(reference);
  if (match) {
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3] || "HEAD"}/${match[4]}`;
  }
  match = GITLAB_BLOB.exec(page);
  if (match) {
    return `${match[1]}/-/raw/${match[2]}`;
  }
  match = GITLAB_SHORT.exec(reference);
  if (match) {
    return `https://gitlab.com/${match[1]}/-/raw/${match[2] || "HEAD"}/${match[3]}`;
  }
  return null;
}

/** Fetch and parse a JSON document, with the URL in every error. */
export async function fetchJsonDocument(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    return parseJsonc(text);
  } catch (error) {
    throw new Error(`not valid JSON (${error.message})`);
  }
}

/**
 * JSON.parse() that also accepts comments (// and /* *\/) and trailing
 * commas, as Omeka-S-Cli reads blueprints (.jsonc). Strings are left intact.
 */
export function parseJsonc(text) {
  const source = String(text);
  let output = "";
  let pendingComma = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      const start = index;
      for (
        index += 1;
        index < source.length && source[index] !== '"';
        index += 1
      ) {
        if (source[index] === "\\") {
          index += 1;
        }
      }
      output += source.slice(start, index + 1);
      pendingComma = -1;
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      output += "\n";
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        throw new SyntaxError("Unterminated comment");
      }
      index = end + 1;
      output += " ";
    } else if (char === ",") {
      pendingComma = output.length;
      output += char;
    } else if ((char === "}" || char === "]") && pendingComma !== -1) {
      output = `${output.slice(0, pendingComma)} ${output.slice(pendingComma + 1)}${char}`;
      pendingComma = -1;
    } else {
      if (!/\s/u.test(char)) {
        pendingComma = -1;
      }
      output += char;
    }
  }
  return JSON.parse(output);
}
