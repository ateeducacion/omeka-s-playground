#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolvePath(scriptDir, "..");

// Only bundle the PHP runtime versions this playground actually offers. The
// monolithic @php-wasm/web's loadWebRuntime() switch dynamically imports every
// @php-wasm/web-X-Y package, so esbuild can't tree-shake and would emit all 8
// versions' .wasm (~798 MB) into dist/ — even though the browser only ever
// downloads the one version a session selects. Stub the non-offered version
// packages so their assets are never emitted (a deploy/CI/disk reduction;
// runtime behavior for the offered versions is unchanged).
const ALL_PHP_VERSIONS = [
  "5-2",
  "7-4",
  "8-0",
  "8-1",
  "8-2",
  "8-3",
  "8-4",
  "8-5",
];
const offeredPhp = [
  ...new Set(
    (
      JSON.parse(
        readFileSync(resolvePath(repoDir, "playground.config.json"), "utf8"),
      ).runtimes || []
    )
      .map((r) => r.phpVersion)
      .filter(Boolean),
  ),
];
const keepVersions = offeredPhp.map((v) => v.replace(".", "-"));
const dropVersions = ALL_PHP_VERSIONS.filter((v) => !keepVersions.includes(v));

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

console.log(
  `Built dist/php-worker.bundle.js (bundled PHP runtimes: ${keepVersions.join(", ") || "none"})`,
);
