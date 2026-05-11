#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

// @php-wasm/web >= 3.1.22 references "../intl/shared/icu.dat", expecting a
// sibling @php-wasm/intl package that is never published to npm. The file still
// ships inside @php-wasm/web itself, so redirect the import to the existing copy.
const phpWasmWebDir = dirname(require.resolve("@php-wasm/web/package.json"));
const icuDatShim = {
  name: "php-wasm-intl-icu-shim",
  setup(api) {
    api.onResolve({ filter: /\.\.\/intl\/shared\/icu\.dat$/ }, () => ({
      path: resolvePath(phpWasmWebDir, "shared/icu.dat"),
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
  plugins: [icuDatShim],
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

console.log("Built dist/php-worker.bundle.js");
