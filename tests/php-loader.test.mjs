import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createFakeRawPhp } from "./helpers/fake-php.mjs";

// php-loader's WASM collaborators are replaced by doubles driven through
// globalThis.__loaderStub; the rest (php-compat, opcache, spawn-handler) is real.
const realUniversal = import.meta.resolve("@php-wasm/universal");
const stubs = {
  "@php-wasm/web": `
    export const loadWebRuntime = (...a) => globalThis.__loaderStub.loadWebRuntime(...a);
    export const generateCertificate = (...a) => globalThis.__loaderStub.generateCertificate(...a);
    export const certificateToPEM = (c) => "PEM:" + c;`,
  "@php-wasm/universal": `
    export * from ${JSON.stringify(realUniversal)};
    export const PHP = function (id) { return globalThis.__loaderStub.createPhp(id); };
    export const setPhpIniEntries = (...a) => globalThis.__loaderStub.setPhpIniEntries(...a);`,
  "./fs-persistence.js": `
    export const clearJournal = (...a) => globalThis.__loaderStub.clearJournal(...a);
    export const initFsPersistence = (...a) => globalThis.__loaderStub.initFsPersistence(...a);`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/src/runtime/php-loader.js") &&
      stubs[specifier]
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { __private__dont__use } = await import("@php-wasm/universal");
const { createPhpRuntime } = await import("../src/runtime/php-loader.js");

function installStub({ mkdirThrows = false } = {}) {
  const calls = {
    certificates: 0,
    load: [],
    ini: [],
    clear: [],
    init: [],
    sapi: [],
    spawn: [],
    phps: [],
  };
  globalThis.__loaderStub = {
    async generateCertificate(spec) {
      calls.certificates += 1;
      assert.equal(spec.basicConstraints.ca, true);
      return { certificate: "CERT" };
    },
    async loadWebRuntime(version, options) {
      calls.load.push({ version, options });
      return 7;
    },
    createPhp(id) {
      const raw = createFakeRawPhp({ onRun: () => ({ body: "served" }) });
      raw.runtimeId = id;
      // @php-wasm creates /internal/shared before the app runs.
      raw.FS.mkdirTree("/internal/shared");
      // The real PHP exposes the Emscripten module synchronously.
      raw[__private__dont__use] = { FS: raw.FS };
      if (mkdirThrows) {
        const real = raw.FS.mkdirTree;
        raw.FS.mkdirTree = (path) => {
          real(path);
          throw new Error("EEXIST");
        };
      }
      raw.unlinked = [];
      raw.unlink = (path) => raw.unlinked.push(path);
      raw.setSapiName = async (name) => calls.sapi.push(name);
      raw.setSpawnHandler = async (handler) => calls.spawn.push(handler);
      calls.phps.push(raw);
      return raw;
    },
    async setPhpIniEntries(php, entries) {
      calls.ini.push({ php, entries });
    },
    async clearJournal(scope) {
      calls.clear.push(scope);
    },
    async initFsPersistence(php, scope) {
      calls.init.push({ php, scope });
      return {
        async flushNow(options) {
          return { ok: true, flushedOps: 2, options };
        },
      };
    },
  };
  return calls;
}

describe("createPhpRuntime", () => {
  it("rejects use before refresh() and reports persistence as disabled", async () => {
    const php = createPhpRuntime(null);
    for (const method of [
      "request",
      "analyzePath",
      "mkdir",
      "writeFile",
      "readFile",
      "unlink",
      "run",
    ]) {
      await assert.rejects(php[method](), /not initialized/);
    }
    assert.equal(php.addEventListener(), undefined);
    assert.equal(php.removeEventListener(), undefined);
    assert.deepEqual(await php.flushPersistence(), {
      enabled: false,
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
  });

  it("boots a plain runtime with the default PHP version, CA and ini", async () => {
    const calls = installStub();
    const php = createPhpRuntime(null);
    await php.refresh();
    const raw = calls.phps[0];

    assert.equal(calls.load[0].version, "8.3");
    assert.equal(calls.load[0].options.withIntl, true);
    assert.deepEqual(calls.load[0].options.tcpOverFetch, {
      CAroot: { certificate: "CERT" },
    });
    assert.equal(raw.runtimeId, 7);
    assert.deepEqual(calls.sapi, []);
    assert.deepEqual(calls.spawn, []);
    assert.deepEqual(calls.init, []);
    for (const dir of [
      "/tmp",
      "/www/omeka",
      "/persist",
      "/internal/shared/preload",
      "/internal/shared/opcache",
    ]) {
      assert.ok(raw.isDir(dir), dir);
    }
    assert.equal(
      raw.readFileAsText("/internal/shared/playground-ca.pem"),
      "PEM:CERT\n",
    );
    assert.ok(raw.fileExists("/internal/shared/opcache-blacklist.txt"));
    const { entries } = calls.ini[0];
    assert.equal(entries.memory_limit, "256M");
    assert.equal(
      entries["openssl.cafile"],
      "/internal/shared/playground-ca.pem",
    );
    assert.equal(entries["curl.cainfo"], "/internal/shared/playground-ca.pem");

    // The wrapped API replaces the placeholders and reaches the raw runtime.
    assert.equal(php._php, raw);
    assert.equal((await php.binary).FS, raw.FS);
    raw.writeFile("/www/omeka/index.php", "<?php");
    const response = await php.request(new Request("http://x/admin"));
    assert.equal(await response.text(), "served");
    assert.equal(raw.runs[0].$_SERVER.HTTP_HOST, "localhost:8080");
    php.unlink("/persist/x");
    assert.deepEqual(raw.unlinked, ["/persist/x"]);
    assert.equal((await php.flushPersistence()).enabled, false);
  });

  it("wires persistence, OPcache, the spawn handler and proxies on a scoped runtime", async () => {
    const calls = installStub({ mkdirThrows: true });
    const php = createPhpRuntime(null, {
      appBaseUrl: "https://app.test/omeka-s-playground/",
      phpVersion: "8.4",
      webRoot: "/srv/web",
      phpCorsProxyUrl: "https://cors.test/?",
      cliExecutor: async () => ({ stdout: "", exitCode: 0 }),
      scopeId: "scope-1",
      forceCleanBoot: true,
      opcache: true,
    });
    await php.refresh();
    const raw = calls.phps[0];

    assert.equal(calls.load[0].version, "8.4");
    assert.equal(
      calls.load[0].options.tcpOverFetch.corsProxyUrl,
      "https://cors.test/?",
    );
    assert.deepEqual(calls.sapi, ["uwsgi"]);
    assert.deepEqual(calls.clear, ["scope-1"]);
    assert.equal(calls.init[0].scope, "scope-1");
    assert.equal(calls.init[0].php, raw);
    assert.equal(typeof calls.spawn[0], "function");
    // The CA is generated once per worker and reused by later runtimes.
    assert.equal(calls.certificates, 0);

    assert.deepEqual(
      await php.flushPersistence({ pathPrefix: "/persist/mutable/files" }),
      {
        enabled: true,
        ok: true,
        flushedOps: 2,
        options: { pathPrefix: "/persist/mutable/files" },
      },
    );

    assert.throws(() => raw.mkdirTree("/srv/web"), /EEXIST/); // still creates it
    raw.writeFile("/srv/web/index.php", "<?php");
    await php.request(new Request("http://x/admin"));
    assert.equal(raw.runs[0].scriptPath, "/srv/web/index.php");
    assert.equal(
      raw.runs[0].$_SERVER.SCRIPT_NAME,
      "/omeka-s-playground/index.php",
    );
  });

  it("prefers corsProxyUrl and keeps the journal on a normal scoped boot", async () => {
    const calls = installStub();
    const php = createPhpRuntime(null, {
      corsProxyUrl: "https://primary.test/",
      phpCorsProxyUrl: "https://secondary.test/",
      scopeId: "scope-2",
    });
    await php.refresh();
    assert.equal(
      calls.load[0].options.tcpOverFetch.corsProxyUrl,
      "https://primary.test/",
    );
    assert.deepEqual(calls.clear, []);
    assert.equal(calls.init[0].scope, "scope-2");
  });
});
