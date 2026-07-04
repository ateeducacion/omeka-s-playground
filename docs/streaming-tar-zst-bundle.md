# Streaming `tar.zst` core bundle

## Summary

The readonly Omeka S core is now shipped as a single, solid, zstd-compressed tar
(`omeka-core-<release>.tar.zst`) instead of a ZIP. The browser runtime extracts it
by **streaming zstd decode + incremental TAR parsing**, writing each file into the
PHP-WASM in-memory filesystem (MEMFS) as it is decoded. The ZIP path has been
**fully removed** — there is no ZIP fallback for the core bundle. This keeps the
boot path simpler and smaller.

This change ports a mechanism proven in the sibling **moodle-playground** project
(see its `docs/decisions/0018-core-bundle-solid-compression-experiment.md` and
`0019-streaming-tar-zstd-core-bundle-extraction.md`, the source of the measurements
quoted below).

## Why

- **~50% smaller download.** A solid zstd tar deduplicates across files far better
  than per-entry ZIP DEFLATE. On a real network the smaller download hides behind
  the WASM compile instead of blocking boot — the moodle experiment measured roughly
  **3× faster cold boot on Cloudflare**.
- **Bounded peak memory.** The large uncompressed tar is *never* fully materialized.
  The decoder holds only the zstd window plus, at any instant, one partial 512-byte
  header, the current entry's bytes (bounded by the largest single file), and one
  decoded chunk — a few MiB, not the whole tree. This avoids both the `fflate`
  `unzipSync` whole-archive heap peak and the per-entry `DecompressionStream`
  overhead of the previous ZIP paths.
- **Chrome and Firefox.** No shipping browser exposes `DecompressionStream("zstd")`,
  so a small WASM decoder (`zstddec`) is bundled and used for the zstd codec; the
  native `DecompressionStream` is still used when a codec is natively supported.
- **Simpler.** One format, one code path, no `ZipArchive` dependency for the core.

## Mechanism

1. **Build** (`scripts/build-omeka-bundle.sh` → `scripts/build-tar-zst-bundle.mjs`):
   the staged, root-relative Omeka tree is packed into a **deterministic USTAR**
   archive (with GNU `././@LongLink` for the handful of paths that do not fit the
   USTAR prefix/name split — never PAX, which PHP tar readers mis-handle) and
   compressed with `node:zlib` zstd level 19 + long-distance matching (windowLog 27).
   The helper prints `{ fileCount, bytes, sha256, uncompressedBytes }`; the manifest
   reuses `fileCount`. Requires **Node ≥ 22.15** for native `node:zlib` zstd — CI
   runs Node 24 LTS.
2. **Manifest** (`scripts/generate-manifest.mjs`): the bundle descriptor now carries
   `format: "tar.zst"`, `container: "tar"`, `codec: "zstd"`, alongside the existing
   `path`, `size`, `sha256`, and `fileCount`.
3. **Runtime** (`src/runtime/vfs.js`, `mountReadonlyCore`): the downloaded compressed
   bytes are turned into a `ReadableStream` of decoded tar bytes by
   `createDecodedTarStream(bytes, "zstd")`, then `extractTarStreamToPhp(stream, php,
   root)` parses USTAR/GNU-longlink entries incrementally and writes each file into
   MEMFS via the raw Emscripten module (`php._php.mkdirTree` / `php._php.writeFile`).
   The streamed file count is checked against `manifest.bundle.fileCount` and the
   boot fails loud on a mismatch (the install is not cached, so a reload retries).

Path safety mirrors the previous ZIP boot path: absolute paths and `..` traversal
segments are rejected (fail loud), separators are normalized, and empty entries are
skipped — no TAR-slip.

## Scope and non-changes

- The **add-on / theme installer** (`src/runtime/addons.js`) still installs external
  module/theme **ZIPs** via `fflate` + `@php-wasm/stream-compression`'s
  `streamZipEntries`. That path is orthogonal to the core bundle and is unchanged;
  `fflate` and `@php-wasm/stream-compression` remain dependencies.
- The core bundle is a single sub-25 MiB file, so no chunking is involved.

## Key files

- `lib/streaming-tar-extract.js` — `createDecodedTarStream`, `extractTarStreamToPhp`,
  `StreamingTarParser`, `sanitizeTarPath`.
- `scripts/lib/tar-ustar.mjs` — deterministic USTAR + GNU-longlink writer/reader.
- `scripts/build-tar-zst-bundle.mjs` — staged tree → deterministic tar → zstd.
- `scripts/generate-manifest.mjs` — bundle descriptor (`format`/`container`/`codec`).
- `src/runtime/vfs.js` — `mountReadonlyCore` streaming extraction + parity check.
