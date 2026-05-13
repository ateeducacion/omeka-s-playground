#!/usr/bin/env node

import { readFile } from "node:fs/promises";
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

// @php-wasm/web's `tcp-over-fetch-websocket.ts` (lines around 643 upstream)
// builds an outbound `ReadableStream` body for every request whose method is
// not exactly "GET", then constructs `new Request(url, { method, body })`.
// HEAD passes through that branch and the browser throws
// `Failed to construct 'Request': Request with GET/HEAD method cannot have body`,
// which surfaces as an uncaught promise rejection from PHP curl. The published
// @php-wasm/web bundle minifies the variable to `S.method`, so we patch the
// single occurrence to also exclude HEAD before esbuild ingests the file.
// Filed upstream at WordPress/wordpress-playground; remove this plugin once
// it lands in a published @php-wasm/web release.
const phpWasmHeadBodyFixPlugin = {
  name: "php-wasm-tcp-over-fetch-head-body-fix",
  setup(b) {
    const phpWasmWebIndex = resolvePath(phpWasmWebDir, "index.js");
    b.onLoad({ filter: /@php-wasm\/web\/index\.js$/ }, async (args) => {
      if (args.path !== phpWasmWebIndex) {
        return null;
      }
      const source = await readFile(args.path, "utf8");
      const pattern = /\bif\s*\(\s*S\.method\s*!==\s*"GET"\s*\)\s*\{/;
      if (!pattern.test(source)) {
        throw new Error(
          "php-wasm-tcp-over-fetch-head-body-fix: pattern not found in "
            + `${args.path}. The upstream bundle layout may have changed; `
            + "verify parseHttpRequest() in @php-wasm/web/index.js and update "
            + "the regex.",
        );
      }
      const patched = source.replace(
        pattern,
        'if (S.method !== "GET" && S.method !== "HEAD") {',
      );
      return { contents: patched, loader: "js" };
    });
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
  plugins: [icuDatShim, phpWasmHeadBodyFixPlugin],
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
