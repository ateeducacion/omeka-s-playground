import {
  buildManifestFilename,
  DEFAULT_OMEKA_VERSION,
} from "../shared/omeka-versions.js";
import { resolveProjectUrl } from "../shared/paths.js";

export function buildManifestUrl(omekaVersion) {
  const filename = buildManifestFilename(omekaVersion || DEFAULT_OMEKA_VERSION);
  return resolveProjectUrl(`assets/manifests/${filename}`);
}

export async function fetchManifest({ omekaVersion } = {}) {
  const versioned = buildManifestUrl(omekaVersion);
  const response = await fetch(versioned, { cache: "no-cache" });
  if (response.ok) {
    const manifest = await response.json();
    manifest._manifestUrl = versioned.toString();
    return manifest;
  }

  if (response.status !== 404) {
    throw new Error(`Unable to load Omeka manifest: ${response.status}`);
  }

  // Fall back to the legacy default manifest for installs that haven't
  // regenerated per-version assets yet.
  const fallback = resolveProjectUrl("assets/manifests/latest.json");
  const fallbackResponse = await fetch(fallback, { cache: "no-cache" });
  if (!fallbackResponse.ok) {
    throw new Error(
      `Unable to load Omeka manifest (version=${omekaVersion || "default"}): ${response.status}`,
    );
  }
  const manifest = await fallbackResponse.json();
  manifest._manifestUrl = fallback.toString();
  return manifest;
}

export function buildManifestState(manifest, runtimeId, bundleVersion) {
  return {
    runtimeId,
    bundleVersion,
    release: manifest.release,
    sha256: manifest.bundle?.sha256 || null,
    generatedAt: manifest.generatedAt,
  };
}
