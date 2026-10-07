// Validation against the shared Omeka S blueprint schema (floating v0). The
// schema is a local copy of the published one (see scripts/sync-blueprint-schema.mjs),
// so booting never fetches it. The browser loads this module through the
// dist/blueprint-schema.bundle.js bundle built by scripts/esbuild.worker.mjs.
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../assets/blueprints/shared/v0/blueprint-schema.json" with {
  type: "json",
};

// The list (or settings) definition an `$import`ed document is validated against.
const IMPORT_DEFS = {
  modules: "moduleList",
  themes: "themeList",
  files: "fileList",
  vocabularies: "vocabularyList",
  resourceTemplates: "resourceTemplateList",
  settings: "settings",
  users: "userList",
  itemSets: "itemSetList",
  items: "itemList",
};
// Lists without a list definition in the schema: each entry is checked against
// the entry definition (as Omeka-S-Cli does for `sites`).
const IMPORT_ENTRY_DEFS = { sites: "site" };

// Omeka S accepts letters, digits, underscores and hyphens in a site slug.
const SITE_SLUG = /^[a-zA-Z0-9_-]+$/u;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema);

export const SHARED_BLUEPRINT_SCHEMA_ID = schema.$id;

/** The keys whose entries may be `$import` references in the shared schema. */
export const IMPORTABLE_KEYS = [
  ...Object.keys(IMPORT_DEFS),
  ...Object.keys(IMPORT_ENTRY_DEFS),
];

function formatErrors(validate) {
  const messages = (validate.errors || []).map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );
  return [...new Set(messages)];
}

/** Schema errors of a whole blueprint (normally with its `$import` entries resolved). */
export function validateBlueprintSchema(document) {
  const validate = ajv.getSchema(SHARED_BLUEPRINT_SCHEMA_ID);
  return validate(document) ? [] : formatErrors(validate);
}

/** Errors of a document `$import`ed under `key` (a list, or the settings value). */
export function validateImportedDocument(key, document) {
  const entryDef = IMPORT_ENTRY_DEFS[key];
  if (entryDef) {
    const validate = ajv.getSchema(
      `${SHARED_BLUEPRINT_SCHEMA_ID}#/$defs/${entryDef}`,
    );
    // A nested `$import` is checked when its own document is imported.
    return (Array.isArray(document) ? document : [document]).flatMap(
      (entry, index) =>
        isReference(entry) || validate(entry)
          ? []
          : formatErrors(validate).map((error) => `/${index}${error}`),
    );
  }
  const def = IMPORT_DEFS[key];
  if (!def) {
    return [`"${key}" does not accept $import entries`];
  }
  const validate = ajv.getSchema(`${SHARED_BLUEPRINT_SCHEMA_ID}#/$defs/${def}`);
  return validate(document) ? [] : formatErrors(validate);
}

const isReference = (entry) =>
  Boolean(entry) &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  Object.keys(entry).length === 1 &&
  typeof entry.$import === "string" &&
  entry.$import.length > 0;

const lower = (value) => String(value ?? "").toLowerCase();

/**
 * Cross-references the schema cannot express, as Omeka-S-Cli's validator
 * checks them on the import-resolved blueprint: item sets named by items, site
 * slugs, site themes, and the users named by site permissions.
 */
export function validateBlueprintReferences(blueprint) {
  const errors = [];
  const list = (key) => (Array.isArray(blueprint?.[key]) ? blueprint[key] : []);

  const itemSets = list("itemSets").map((itemSet) => lower(itemSet?.title));
  list("items").forEach((item, index) => {
    for (const title of item?.itemSets || []) {
      if (!itemSets.includes(lower(title))) {
        errors.push(`items[${index}]: references unknown item set '${title}'`);
      }
    }
  });

  // a permission may name a blueprint user or the install admin
  const users = list("users").map((user) => lower(user?.email));
  if (blueprint?.install?.admin?.email) {
    users.push(lower(blueprint.install.admin.email));
  }
  // `default` ships with the core
  const themes = [
    "default",
    ...list("themes").map((theme) => lower(theme?.name ?? theme)),
  ];
  list("sites").forEach((site, index) => {
    const label = site?.title ?? site?.slug ?? index;
    if (typeof site?.slug === "string" && !SITE_SLUG.test(site.slug)) {
      errors.push(
        `site '${label}': invalid slug '${site.slug}' (only letters, digits, '_' and '-' are allowed)`,
      );
    }
    if (
      typeof site?.theme === "string" &&
      !themes.includes(lower(site.theme))
    ) {
      errors.push(
        `site '${label}': theme '${site.theme}' is not declared in themes`,
      );
    }
    for (const permission of site?.permissions || []) {
      if (permission?.user && !users.includes(lower(permission.user))) {
        errors.push(
          `site '${label}': permission references unknown user '${permission.user}'`,
        );
      }
    }
  });
  return errors;
}
