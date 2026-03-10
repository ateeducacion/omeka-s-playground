export async function fetchManifest() {
  const url = new URL("../../assets/manifests/latest.json", import.meta.url);
  const response = await fetch(url, { cache: "no-cache" });

  if (!response.ok) {
    throw new Error(`Unable to load Omeka manifest: ${response.status}`);
  }

  return response.json();
}

export function buildManifestState(manifest, runtimeId, bundleVersion) {
  return {
    runtimeId,
    bundleVersion,
    release: manifest.release,
    sha256: manifest.vfs?.data?.sha256 || null,
    generatedAt: manifest.generatedAt,
  };
}
