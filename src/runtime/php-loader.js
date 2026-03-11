import { PhpCgiWorker } from "../../vendor/php-cgi-wasm/PhpCgiWorker.js";
import { PGlite } from "../../vendor/pglite/index.js";
import { resolveSharedLibs } from "./runtime-registry.js";
import { OMEKA_ROOT } from "./bootstrap.js";

const MIME_TYPES = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};

export function createPhpRuntime(runtime, options = {}) {
  const { moduleArgs = {} } = options;

  return new PhpCgiWorker({
    PGlite,
    prefix: "/",
    docroot: OMEKA_ROOT,
    sharedLibs: resolveSharedLibs(runtime),
    types: MIME_TYPES,
    rewrite: (pathname) => pathname,
    ...moduleArgs,
  });
}
