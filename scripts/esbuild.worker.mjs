#!/usr/bin/env node

import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { ALL_PHP_VERSIONS as SUPPORTED_PHP_VERSIONS } from "../src/shared/omeka-versions.js";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolvePath(scriptDir, "..");

// Only bundle the PHP runtime versions supported by the compatibility matrix.
// The shell can synthesize every valid PHP/Omeka combination even when
// playground.config.json contains only a curated list of default runtimes.
// The monolithic @php-wasm/web's loadWebRuntime() switch dynamically imports
// every @php-wasm/web-X-Y package, so esbuild can't tree-shake and would emit
// all 8 versions' .wasm (~798 MB) into dist/. Stub only the unsupported version
// packages so every runtime offered by the UI remains available.
const PHP_WASM_VERSIONS = [
  "5-2",
  "7-4",
  "8-0",
  "8-1",
  "8-2",
  "8-3",
  "8-4",
  "8-5",
];
const keepVersions = SUPPORTED_PHP_VERSIONS.map((version) =>
  version.replace(".", "-"),
);
const dropVersions = PHP_WASM_VERSIONS.filter(
  (version) => !keepVersions.includes(version),
);

const stripUnusedPhpVersions = {
  name: "strip-unused-php-versions",
  setup(api) {
    if (dropVersions.length === 0) return;
    const filter = new RegExp(
      `@php-wasm/(?:web|node)-(?:${dropVersions.join("|")})(?:/|$)`,
    );
    api.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "phpver-stub",
    }));
    api.onLoad({ filter: /.*/, namespace: "phpver-stub" }, (args) => ({
      loader: "js",
      contents:
        `export function getPHPLoaderModule(){throw new Error("PHP runtime not bundled in this build: ${args.path}");}\n` +
        `export function getIntlExtensionPath(){throw new Error("PHP intl not bundled in this build: ${args.path}");}\n`,
    }));
  },
};

const phpWasmWebPackage = JSON.parse(
  readFileSync(require.resolve("@php-wasm/web/package.json"), "utf8"),
);
const ICU_DATA_URL = `https://unpkg.com/@php-wasm/web@${phpWasmWebPackage.version}/shared/icu.dat`;
const icuDatShim = {
  name: "php-wasm-intl-icu-shim",
  setup(api) {
    api.onResolve(
      { filter: /(^|\/)(?:intl\/shared|shared)\/icu\.dat$/ },
      () => ({
        path: "external-icu-data-url",
        namespace: "external-icu-data-url",
      }),
    );
    api.onLoad({ filter: /.*/, namespace: "external-icu-data-url" }, () => ({
      loader: "js",
      contents: `export default ${JSON.stringify(ICU_DATA_URL)};`,
    }));
  },
};

rmSync(resolvePath(repoDir, "dist"), { force: true, recursive: true });

await build({
  entryPoints: ["php-worker.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "php-worker.bundle",
  assetNames: "[name]-[hash]",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  banner: {
    js: `const __APP_ROOT__ = new URL("../", import.meta.url).href;`,
  },
  plugins: [icuDatShim, stripUnusedPhpVersions],
  loader: {
    ".wasm": "file",
    ".so": "file",
    ".dat": "file",
  },
  // Node.js built-ins referenced by Emscripten-generated code (conditional,
  // never executed in browser). Mark them as external to avoid resolution errors.
  external: [
    "worker_threads",
    "events",
    "fs",
    "path",
    "crypto",
    "os",
    "url",
    "child_process",
    "net",
    "tls",
    "http",
    "https",
    "stream",
    "zlib",
    "util",
    "assert",
    "buffer",
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
});

// The cache version lives in src/generated/build-version.js, written by
// scripts/write-build-version.mjs (`npm run build:version`). It used to be a
// content hash of this bundle, which could not tell two builds of the same
// source apart; it is now the deployment Build ID.
// See docs/architecture/adr/ADR-0029-build-identification-and-cache-versioning.md
console.log(
  `Built dist/php-worker.bundle.js (bundled PHP runtimes: ${keepVersions.join(", ") || "none"})`,
);
