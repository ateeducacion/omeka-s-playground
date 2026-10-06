// The omeka.org add-on catalogs, keyed by add-on directory name.
export const OMEKA_CATALOG_URLS = {
  module: "https://omeka.org/add-ons/json/s_module.json",
  theme: "https://omeka.org/add-ons/json/s_theme.json",
};

/**
 * The download URL of an add-on release in an omeka.org catalog: the requested
 * version (a leading "v" is ignored), or the latest one. The name matches the
 * catalog key or `dirname`, case-insensitively.
 *
 * ponytail: no Omeka version constraint check; pin `version` if the latest
 * release does not support the bundled Omeka S.
 */
export function resolveCatalogRelease(catalog, name, version = "") {
  const wanted = String(name).toLowerCase();
  const entry = Object.entries(catalog || {}).find(
    ([key, value]) =>
      key.toLowerCase() === wanted ||
      String(value?.dirname || "").toLowerCase() === wanted,
  )?.[1];
  if (!entry) {
    throw new Error(`Add-on "${name}" is not in the omeka.org catalog.`);
  }

  const release = String(version || entry.latest_version || "").replace(
    /^v/iu,
    "",
  );
  const downloadUrl = entry.versions?.[release]?.download_url;
  if (!downloadUrl) {
    throw new Error(
      `Add-on "${name}" has no release "${release}" in the omeka.org catalog.`,
    );
  }
  return downloadUrl;
}
