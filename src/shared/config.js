import { resolveProjectUrl } from "./paths.js";

const CONFIG_URL = resolveProjectUrl("playground.config.json");

let configPromise;

export async function loadPlaygroundConfig() {
  if (!configPromise) {
    configPromise = fetch(CONFIG_URL, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Unable to load playground config: ${response.status}`,
          );
        }

        return response.json();
      })
      .catch((error) => {
        // Do not memoize a failure: let the next caller retry the fetch.
        configPromise = undefined;
        throw error;
      });
  }

  return configPromise;
}

export function getDefaultRuntime(config) {
  return (
    config.runtimes.find((runtime) => runtime.default) || config.runtimes[0]
  );
}
