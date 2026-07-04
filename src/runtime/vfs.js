import { resolveBootstrapArchive } from "../../lib/omeka-loader.js";
import {
  createDecodedTarStream,
  extractTarStreamToPhp,
} from "../../lib/streaming-tar-extract.js";

export async function mountReadonlyCore(
  php,
  manifest,
  { root = "/www/omeka", publish, bytes = null } = {},
) {
  // Parallel boot: prefer the core bytes the worker downloaded while the WASM
  // runtime was compiling. Fall back to a lazy download when called without
  // them (e.g. the short-lived CLI media runtime), where the bundle is served
  // from the Cache API so the duplicate fetch is cheap.
  let archiveBytes = bytes;
  if (!archiveBytes) {
    const archive = await resolveBootstrapArchive({ manifest }, (progress) => {
      if (publish && progress.ratio !== undefined) {
        publish(
          `Downloading Omeka bundle: ${Math.round(progress.ratio * 100)}%`,
          0.3 + progress.ratio * 0.15,
        );
      }
    });
    archiveBytes = archive.bytes;
  }

  // Extract the core by streaming-decoding the solid `tar.zst` bundle straight
  // into MEMFS: zstd is decoded incrementally (zstddec streaming) and each USTAR
  // entry is written as it is parsed, so the large uncompressed tar is never
  // materialized — peak memory stays bounded to roughly one file plus one decoded
  // chunk. This replaces the previous ZIP path (write to MEMFS + PHP
  // ZipArchive::extractTo) with a format that is ~50% smaller (the download hides
  // behind the WASM compile) and works on Chrome and Firefox. No JS fallback by
  // design — the install is not cached, so a reload retries. See
  // docs/streaming-tar-zst-bundle.md.
  publish?.("Extracting Omeka core…", 0.45);
  const stream = await createDecodedTarStream(archiveBytes, "zstd");
  // Drop the JS reference to the compressed buffer now that the stream owns it,
  // so the GC can reclaim it while extraction proceeds.
  archiveBytes = null;
  const stats = await extractTarStreamToPhp(stream, php, root);

  // Parity: the streamed file count must match the manifest, or the bundle was
  // truncated / does not match the manifest — fail loud.
  const expected = manifest?.bundle?.fileCount;
  if (expected && stats.fileCount !== expected) {
    throw new Error(
      `Omeka core tar file-count parity mismatch: ${stats.fileCount} != ${expected}`,
    );
  }

  return { manifest, entries: stats.fileCount };
}

export async function fetchArrayBuffer(path, cache = "default") {
  const response = await fetch(path, { cache });
  if (!response.ok) {
    throw new Error(`Unable to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
}
