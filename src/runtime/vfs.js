import {
  extractZipEntries,
  resolveBootstrapArchive,
  writeEntriesToPhp,
} from "../../lib/omeka-loader.js";

export async function mountReadonlyCore(
  php,
  manifest,
  { root = "/www/omeka", publish } = {},
) {
  const archive = await resolveBootstrapArchive(
    { manifestUrl: manifest._manifestUrl },
    (progress) => {
      if (publish && progress.ratio !== undefined) {
        publish(
          `Downloading Omeka bundle: ${Math.round(progress.ratio * 100)}%`,
          0.3 + progress.ratio * 0.15,
        );
      }
    },
  );

  const entries = extractZipEntries(archive.bytes);

  const binary = await php.binary;
  const phpWithFS = binary?.FS ? { FS: binary.FS } : php;

  writeEntriesToPhp(phpWithFS, entries, root, ({ ratio, path }) => {
    if (publish) {
      publish(`Writing ${path}`, 0.45 + ratio * 0.1);
    }
  });

  return { manifest: archive.manifest, entries: entries.length };
}

export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}
