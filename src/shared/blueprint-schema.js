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

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema);

export const SHARED_BLUEPRINT_SCHEMA_ID = schema.$id;

/** The keys whose entries may be `$import` references in the shared schema. */
export const IMPORTABLE_KEYS = Object.keys(IMPORT_DEFS);

function formatErrors(validate) {
  const messages = (validate.errors || []).map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );
  return [...new Set(messages)];
}

/** Errors of a whole blueprint document (with its `$import` entries unresolved). */
export function validateBlueprintSchema(document) {
  const validate = ajv.getSchema(SHARED_BLUEPRINT_SCHEMA_ID);
  return validate(document) ? [] : formatErrors(validate);
}

/** Errors of a document `$import`ed under `key` (a list, or the settings value). */
export function validateImportedDocument(key, document) {
  const def = IMPORT_DEFS[key];
  if (!def) {
    return [`"${key}" does not accept $import entries`];
  }
  const validate = ajv.getSchema(`${SHARED_BLUEPRINT_SCHEMA_ID}#/$defs/${def}`);
  return validate(document) ? [] : formatErrors(validate);
}
