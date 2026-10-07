import { BUILD_VERSION } from "../generated/build-version.js";

let validatorPromise = null;

/**
 * The shared-schema validator (src/shared/blueprint-schema.js), bundled with
 * Ajv into dist/ by `npm run build-worker`. Loaded once, on demand.
 */
export function loadBlueprintSchemaValidator() {
  if (!validatorPromise) {
    const url = new URL(
      "../../dist/blueprint-schema.bundle.js",
      import.meta.url,
    );
    url.searchParams.set("v", BUILD_VERSION);
    validatorPromise = import(/* webpackIgnore: true */ url.href);
  }
  return validatorPromise;
}
