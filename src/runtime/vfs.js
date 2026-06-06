import { resolveBootstrapArchive } from "../../lib/omeka-loader.js";
import { buildCoreExtractScript } from "./core-extract-script.js";

const decoder = new TextDecoder();

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

  // Extract the core with PHP's native ZipArchive instead of decompressing the
  // whole ~19 MB / 9 310-file archive in JS on every boot. libzip inflates +
  // writes one entry at a time (fast at any file count, ~one-entry peak),
  // avoiding both the fflate `unzipSync` heap OOM and the per-entry
  // DecompressionStream overhead of `decodeZip` (which made boot exceed the
  // readiness gate). Write the zip to MEMFS, run the extractor, then fail loud
  // if ext/zip is missing or it errors — the install is not cached, so a reload
  // retries (no JS fallback by design).
  const tmpZip = "/tmp/omeka-core.zip";
  const stage = "/tmp/omeka-core-stage";
  publish?.("Extracting Omeka core…", 0.45);
  await php.writeFile(tmpZip, archive.bytes);
  // Drop the JS reference to the compressed buffer now that MEMFS has its own
  // copy, so the GC can reclaim it while ZipArchive extracts.
  archive.bytes = null;
  const result = await php.run(buildCoreExtractScript(tmpZip, stage, root));
  const out = decoder.decode(result.bytes || new Uint8Array()).trim();
  if (!out.startsWith("INSTALL_OK")) {
    throw new Error(
      `Omeka core extraction failed: ${out.slice(0, 200)} ` +
        "(PHP ext/zip is required to mount the core).",
    );
  }
  const written = Number.parseInt(out.slice("INSTALL_OK".length).trim(), 10);

  return { manifest: archive.manifest, entries: written };
}

export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}
