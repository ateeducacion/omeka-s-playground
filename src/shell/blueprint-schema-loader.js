import { BUILD_VERSION } from "../generated/build-version.js";

let validatorPromise = null;
let failedLoads = 0;

/**
 * The shared-schema validator (src/shared/blueprint-schema.js), bundled with
 * Ajv into dist/ by `npm run build-worker`. Loaded once, on demand; a failed
 * load is forgotten so the next call tries again.
 */
export function loadBlueprintSchemaValidator() {
  if (!validatorPromise) {
    const url = new URL(
      "../../dist/blueprint-schema.bundle.js",
      import.meta.url,
    );
    url.searchParams.set("v", BUILD_VERSION);
    // The browser's module map can keep a failed fetch for its URL, so a
    // retry of the same URL would fail again without reaching the network.
    if (failedLoads) {
      url.searchParams.set("retry", String(failedLoads));
    }
    validatorPromise = import(/* webpackIgnore: true */ url.href).catch(
      (error) => {
        failedLoads += 1;
        validatorPromise = null;
        throw error;
      },
    );
  }
  return validatorPromise;
}
