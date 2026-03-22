export async function fetchManifest() {
  const url = new URL("../../assets/manifests/latest.json", import.meta.url);
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load Omeka manifest: ${response.status}`);
  }
  const manifest = await response.json();
  // Attach the manifest URL so vfs.js can resolve relative bundle paths.
  manifest._manifestUrl = url.toString();
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
