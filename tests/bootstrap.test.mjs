import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { createUstarTar } from "../scripts/lib/tar-ustar.mjs";
import {
  bootstrapOmeka,
  OMEKA_FILES_PATH,
  OMEKA_ROOT,
  PLAYGROUND_CONFIG_PATH,
  PLAYGROUND_DB_PATH,
  PLAYGROUND_PREPEND_PATH,
  prepareOmekaRuntimeFilesystem,
  startCoreArchivePrefetch,
} from "../src/runtime/bootstrap.js";
import { wrapPhpInstance } from "../src/runtime/php-compat.js";
import { createFakeRawPhp, stubFetch } from "./helpers/fake-php.mjs";

const config = JSON.parse(
  readFileSync(new URL("../playground.config.json", import.meta.url), "utf8"),
);
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

const CORE_FILES = {
  "index.php": "<?php // front controller",
  "bootstrap.php": "<?php",
  "config/.keep": "",
};

function buildCore(files = CORE_FILES) {
  const tar = createUstarTar(
    Object.entries(files).map(([path, data]) => ({
      name: path,
      data: enc(data),
    })),
  );
  return {
    manifest: {
      release: "4.2.1",
      generatedAt: "2026-01-01T00:00:00Z",
      bundle: {
        codec: "gzip",
        sha256: "abc",
        fileCount: Object.keys(files).length,
      },
    },
    bytes: gzipSync(tar),
  };
}

const LOGIN_HTML =
  '<html><body class="login"><form><input type="hidden" name="loginform_csrf" value="tok123"></form></body></html>';

// Scripted PHP: the probe reports sqlite, the installer completes, and the
// login form hands out a CSRF token then redirects to /admin.
function scriptedRun(overrides = {}) {
  return (request) => {
    const path = request.relativeUri.split("?")[0];
    if (overrides[path]) {
      return overrides[path](request);
    }
    if (path === "/playground-probe.php") {
      return {
        body: JSON.stringify({ available_drivers: ["sqlite"] }),
      };
    }
    if (path === "/playground-install.php") {
      return { body: "omeka-playground-bootstrap-complete\n" };
    }
    if (path === "/login" && request.method === "GET") {
      return { body: LOGIN_HTML };
    }
    if (path === "/login" && request.method === "POST") {
      return { status: 302, headers: { location: ["/admin"] } };
    }
    return { body: "<h1>Dashboard</h1>" };
  };
}

function setup({ onRun = scriptedRun(), files } = {}) {
  const raw = createFakeRawPhp({ onRun, files });
  const php = wrapPhpInstance(raw, {
    absoluteUrl: "https://playground.internal",
  });
  // php-loader adds unlink on top of the compat wrapper the same way.
  php.unlink = (path) => raw.unlink(path);
  const messages = [];
  const publish = (message, progress) => messages.push({ message, progress });
  return { raw, php, messages, publish };
}

function runBootstrap(ctx, options = {}) {
  return bootstrapOmeka({
    blueprint: {},
    config,
    corePrefetch: Promise.resolve(buildCore()),
    omekaVersion: "4.2.1",
    php: ctx.php,
    publish: ctx.publish,
    runtimeId: "php83-omeka421",
    ...options,
  });
}

const readText = (raw, path) => dec(raw.FS.readFile(path));

describe("prepareOmekaRuntimeFilesystem", () => {
  it("extracts the prefetched core, links files/ and writes SQLite + PHP config", async () => {
    const ctx = setup();
    const result = await prepareOmekaRuntimeFilesystem({
      blueprint: {
        "x-playground": {
          debug: { enabled: true },
          phpConstants: {
            MY_FLAG: true,
            MY_LIMIT: 3,
            MY_NAME: "it's",
            "bad-name": "skip",
            MY_OBJECT: { nested: 1 },
          },
        },
      },
      config,
      corePrefetch: Promise.resolve(buildCore()),
      php: ctx.php,
      publish: ctx.publish,
      runtimeId: "rt-1",
    });

    const { FS } = ctx.raw;
    assert.equal(
      readText(ctx.raw, `${OMEKA_ROOT}/index.php`),
      CORE_FILES["index.php"],
    );
    for (const dir of [
      "/persist/addons",
      "/persist/mutable/session",
      "/persist/runtime/blueprint-media",
    ]) {
      assert.ok(FS.analyzePath(dir).exists, `${dir} exists`);
    }
    assert.ok(
      FS.isLink(FS.analyzePath(`${OMEKA_ROOT}/files`, true).object.mode),
    );
    assert.equal(FS.readlink(`${OMEKA_ROOT}/files`), OMEKA_FILES_PATH);

    assert.match(
      readText(ctx.raw, `${OMEKA_ROOT}/config/database.ini`),
      new RegExp(`driver = "pdo_sqlite"\\npath = "${PLAYGROUND_DB_PATH}"`),
    );

    const local = readText(ctx.raw, `${OMEKA_ROOT}/config/local.config.php`);
    assert.match(local, /ini_set\('display_errors', '1'\);/);
    assert.match(local, /define\('MY_FLAG', true\)/);
    assert.match(local, /define\('MY_LIMIT', 3\)/);
    assert.match(local, /define\('MY_NAME', 'it\\'s'\)/);
    assert.doesNotMatch(local, /bad-name|MY_OBJECT/);
    assert.match(local, /'is_dev_mode' => true/);

    const ini = readText(ctx.raw, "/php.ini");
    assert.match(ini, /display_errors=1/);
    assert.match(ini, /error_reporting=E_ALL\n/);
    assert.match(
      ini,
      new RegExp(`auto_prepend_file=${PLAYGROUND_PREPEND_PATH}`),
    );

    const prepend = readText(ctx.raw, PLAYGROUND_PREPEND_PATH);
    assert.match(prepend, /APPLICATION_ENV=development/);
    assert.match(prepend, /define\('MY_LIMIT', 3\)/);

    assert.equal(result.manifestState.runtimeId, "rt-1");
    assert.equal(result.manifestState.sha256, "abc");
    assert.equal(result.effectiveConfig.debug.enabled, true);
    assert.ok(
      ctx.messages.some(
        (m) => m.message === "Writing SQLite and local config overrides.",
      ),
    );
  });

  it("keeps production error settings and appends to an existing php.ini", async () => {
    const ctx = setup({ files: { "/php.ini": "memory_limit=1G\n\n" } });
    await prepareOmekaRuntimeFilesystem({
      blueprint: {},
      config,
      corePrefetch: Promise.resolve(buildCore()),
      php: ctx.php,
      runtimeId: "rt",
      mountPersistedAddonsOnly: true,
    });
    const ini = readText(ctx.raw, "/php.ini");
    assert.ok(ini.startsWith("memory_limit=1G\ndisplay_errors=0\n"));
    assert.match(ini, /error_reporting=E_ALL & ~E_DEPRECATED/);
    const local = readText(ctx.raw, `${OMEKA_ROOT}/config/local.config.php`);
    assert.doesNotMatch(local, /ini_set\('display_errors'/);
    assert.match(local, /'is_dev_mode' => false/);
    assert.doesNotMatch(
      readText(ctx.raw, PLAYGROUND_PREPEND_PATH),
      /APPLICATION_ENV/,
    );
  });

  it("replaces a pre-existing files/ directory with the mutable-files link", async () => {
    const ctx = setup({
      files: { [`${OMEKA_ROOT}/files/original/old.jpg`]: "x" },
    });
    await prepareOmekaRuntimeFilesystem({
      blueprint: {},
      config,
      corePrefetch: Promise.resolve(buildCore()),
      php: ctx.php,
      runtimeId: "rt",
    });
    const { FS } = ctx.raw;
    assert.equal(FS.readlink(`${OMEKA_ROOT}/files`), OMEKA_FILES_PATH);
    assert.equal(
      FS.analyzePath(`${OMEKA_ROOT}/files/original/old.jpg`).exists,
      false,
    );
  });

  it("fails loud when the core file count does not match the manifest", async () => {
    const ctx = setup();
    const core = buildCore();
    core.manifest.bundle.fileCount = 99;
    await assert.rejects(
      prepareOmekaRuntimeFilesystem({
        blueprint: {},
        config,
        corePrefetch: Promise.resolve(core),
        php: ctx.php,
        runtimeId: "rt",
      }),
      /parity mismatch: 3 != 99/,
    );
  });

  it("fetches the manifest and bundle when nothing was prefetched", async (t) => {
    const core = buildCore();
    core.manifest.bundle.path = "../omeka/core.tar.gz";
    core.manifest.bundle.sha256 = undefined;
    const calls = stubFetch(t, (url) =>
      url.includes("manifests/")
        ? Response.json(core.manifest)
        : new Response(core.bytes),
    );
    const ctx = setup();
    const result = await prepareOmekaRuntimeFilesystem({
      blueprint: {},
      config,
      omekaVersion: "4.2.1",
      php: ctx.php,
      publish: ctx.publish,
      runtimeId: "rt",
    });
    assert.match(calls[0].url, /assets\/manifests\/.*4\.2\.1.*\.json$/);
    assert.match(calls.at(-1).url, /assets\/omeka\/core\.tar\.gz$/);
    assert.equal(result.manifest.release, "4.2.1");
    assert.ok(
      ctx.messages.some((m) =>
        /^Downloading Omeka bundle: 100%$/.test(m.message),
      ),
    );
    assert.equal(readText(ctx.raw, `${OMEKA_ROOT}/bootstrap.php`), "<?php");
  });
});

describe("startCoreArchivePrefetch", () => {
  it("resolves the version manifest together with the core bytes", async (t) => {
    const core = buildCore();
    core.manifest.bundle.path = "core.tar.gz";
    core.manifest.bundle.sha256 = undefined;
    stubFetch(t, (url) =>
      url.endsWith(".json")
        ? Response.json(core.manifest)
        : new Response(core.bytes),
    );
    const progress = [];
    const result = await startCoreArchivePrefetch({
      omekaVersion: "4.2.1",
      onProgress: (p) => progress.push(p.ratio),
    });
    assert.deepEqual(new Uint8Array(result.bytes), new Uint8Array(core.bytes));
    assert.equal(result.manifest.release, "4.2.1");
    assert.equal(progress.at(-1), 1);
  });
});

describe("bootstrapOmeka", () => {
  it("probes, installs, signs in and lands on the blueprint landing page", async () => {
    const ctx = setup();
    const result = await runBootstrap(ctx, {
      blueprint: { landingPage: "/admin/item" },
    });

    assert.equal(result.readyPath, "/admin/item");
    assert.equal(result.manifestState.release, "4.2.1");

    const install = readText(ctx.raw, `${OMEKA_ROOT}/playground-install.php`);
    assert.match(install, /require '\/www\/omeka\/bootstrap\.php';/);
    assert.match(
      install,
      new RegExp(`\\$statePath = '${PLAYGROUND_CONFIG_PATH}';`),
    );
    assert.match(install, /'email' => 'admin@example\.com'/);
    assert.match(
      readText(ctx.raw, `${OMEKA_ROOT}/playground-probe.php`),
      /PDO::getAvailableDrivers/,
    );

    const paths = ctx.raw.runs.map((r) => `${r.method} ${r.relativeUri}`);
    assert.deepEqual(paths, [
      "GET /playground-probe.php",
      "GET /playground-install.php",
      "GET /login",
      "POST /login",
    ]);
    const loginBody = new URLSearchParams(dec(ctx.raw.runs[3].body));
    assert.equal(loginBody.get("email"), "admin@example.com");
    assert.equal(loginBody.get("password"), "password");
    assert.equal(loginBody.get("loginform_csrf"), "tok123");
    assert.equal(
      ctx.raw.runs[3].$_SERVER.CONTENT_TYPE,
      "application/x-www-form-urlencoded",
    );
    assert.equal(
      ctx.messages.at(-1).message,
      "Bootstrap complete. Omeka is ready.",
    );
  });

  it("re-runs the installer on continue and relays debug, warning and plain output", async () => {
    let pass = 0;
    const ctx = setup({
      onRun: scriptedRun({
        "/playground-install.php": () => {
          pass += 1;
          return pass === 1
            ? {
                body: "[debug] modules\r\n[warning] slow\nhello\nomeka-playground-bootstrap-continue\n",
              }
            : { body: "omeka-playground-bootstrap-complete" };
        },
      }),
    });
    await runBootstrap(ctx, { config: { ...config, autologin: false } });
    assert.equal(pass, 2);
    const texts = ctx.messages.map((m) => m.message);
    assert.ok(texts.includes("[debug] modules"));
    assert.ok(texts.includes("[warning] slow"));
    assert.ok(texts.includes("Installer output: hello"));
    assert.ok(texts.includes("Reinitializing Omeka after module install."));
    assert.ok(!ctx.raw.runs.some((r) => r.relativeUri === "/login"));
  });

  it("gives up after ten continuation passes", async () => {
    const ctx = setup({
      onRun: scriptedRun({
        "/playground-install.php": () => ({
          body: "omeka-playground-bootstrap-continue",
        }),
      }),
    });
    await assert.rejects(
      runBootstrap(ctx),
      /did not complete after repeated module install passes/,
    );
    assert.equal(
      ctx.raw.runs.filter((r) => r.relativeUri === "/playground-install.php")
        .length,
      10,
    );
  });

  it("rejects unexpected installer output", async () => {
    const ctx = setup({
      onRun: scriptedRun({
        "/playground-install.php": () => ({ body: "Fatal error: boom" }),
      }),
    });
    await assert.rejects(
      runBootstrap(ctx),
      /Unexpected Omeka bootstrap output: Fatal error: boom/,
    );
  });

  it("rejects a non-JSON probe and a probe without the sqlite driver", async () => {
    const notJson = setup({
      onRun: scriptedRun({
        "/playground-probe.php": () => ({ body: "<b>Parse error</b>" }),
      }),
    });
    await assert.rejects(
      runBootstrap(notJson),
      /Probe response was not valid JSON: <b>Parse error<\/b>/,
    );

    const noSqlite = setup({
      onRun: scriptedRun({
        "/playground-probe.php": () => ({
          body: '{"available_drivers":["mysql"]}',
        }),
      }),
    });
    await assert.rejects(runBootstrap(noSqlite), /SQLite probe failed/);
  });

  it("falls back to /login with a warning when the admin session is not established", async () => {
    const ctx = setup({
      onRun: scriptedRun({
        "/login": (request) =>
          request.method === "POST"
            ? { body: "<h1>Log in</h1>" }
            : { body: '<form><input name="x"></form>' },
        "/admin": () => ({ status: 302, headers: { location: ["/login"] } }),
      }),
    });
    const result = await runBootstrap(ctx, {
      blueprint: { landingPage: "/s/demo" },
    });
    assert.equal(result.readyPath, "/login");
    assert.ok(
      ctx.messages.some(
        (m) =>
          m.message ===
          "[warning] Automatic admin login did not establish a browser session.",
      ),
    );
    const loginBody = new URLSearchParams(
      dec(ctx.raw.runs.find((r) => r.method === "POST").body),
    );
    assert.equal(loginBody.has("loginform_csrf"), false);
  });

  it("treats an admin page reached without a redirect as a successful login", async () => {
    const ctx = setup({
      onRun: scriptedRun({ "/login": () => ({ body: "ok" }) }),
    });
    const result = await runBootstrap(ctx);
    assert.equal(result.readyPath, "/admin");
    assert.ok(ctx.raw.runs.some((r) => r.relativeUri === "/admin"));
  });

  it("resets persisted state on clean boot", async () => {
    const ctx = setup({
      files: {
        "/persist/mutable/db/omeka.sqlite": "old-db",
        "/persist/runtime/content-seeded.json": "{}",
      },
    });
    await runBootstrap(ctx, { clean: true });
    assert.equal(ctx.raw.FS.analyzePath(PLAYGROUND_DB_PATH).exists, false);
    assert.equal(
      ctx.raw.FS.analyzePath("/persist/runtime/content-seeded.json").exists,
      false,
    );
    assert.ok(ctx.raw.FS.analyzePath("/persist/mutable/db").exists);
    assert.equal(ctx.messages[0].message, "Resetting persisted runtime state.");
  });

  it("boots clean on an empty filesystem and tolerates mkdir races", async () => {
    const ctx = setup();
    const mkdir = ctx.raw.mkdir;
    let raced = 0;
    // Another request created the directory between analyzePath and mkdir.
    ctx.raw.mkdir = (path) => {
      mkdir(path);
      if (path === "/persist/addons") {
        raced += 1;
        throw new Error("EEXIST");
      }
    };
    const result = await runBootstrap(ctx, { clean: true });
    assert.equal(raced, 1);
    assert.equal(result.readyPath, "/admin");
    assert.ok(ctx.raw.FS.analyzePath("/persist/mutable/logs").exists);
  });

  it("omits empty form fields from the login POST", async () => {
    const ctx = setup({
      onRun: scriptedRun({
        "/login": (request) =>
          request.method === "POST"
            ? {
                status: 302,
                headers: { location: ["https://playground.internal/admin/"] },
              }
            : { body: '<input type="hidden" name="csrf" value="">' },
      }),
    });
    const result = await runBootstrap(ctx);
    assert.equal(result.readyPath, "/admin");
    const body = new URLSearchParams(
      dec(ctx.raw.runs.find((r) => r.method === "POST").body),
    );
    assert.equal(body.has("csrf"), false);
    assert.equal(body.get("submit"), "Log in");
  });

  it("drops the database and saved state when the bundle manifest changed", async () => {
    const ctx = setup({
      files: {
        [PLAYGROUND_DB_PATH]: "db",
        [PLAYGROUND_CONFIG_PATH]: JSON.stringify({
          manifest: { release: "4.1.1" },
        }),
      },
    });
    await runBootstrap(ctx);
    assert.equal(ctx.raw.FS.analyzePath(PLAYGROUND_DB_PATH).exists, false);
    assert.equal(ctx.raw.FS.analyzePath(PLAYGROUND_CONFIG_PATH).exists, false);
    assert.ok(
      ctx.messages.some(
        (m) => m.message === "Bundle version changed. Resetting mutable files.",
      ),
    );
  });

  it("keeps the database when the saved manifest matches", async () => {
    const core = buildCore();
    const manifestState = {
      runtimeId: "php83-omeka421",
      bundleVersion: config.bundleVersion,
      release: "4.2.1",
      sha256: "abc",
      generatedAt: core.manifest.generatedAt,
    };
    const ctx = setup({
      files: {
        [PLAYGROUND_DB_PATH]: "db",
        [PLAYGROUND_CONFIG_PATH]: JSON.stringify({ manifest: manifestState }),
      },
    });
    await runBootstrap(ctx, { corePrefetch: Promise.resolve(core) });
    assert.equal(readText(ctx.raw, PLAYGROUND_DB_PATH), "db");
  });

  it("prefetches URL media into the blueprint cache and warns on failures", async (t) => {
    const calls = stubFetch(t, (url) => {
      if (url.includes("broken")) {
        return new Response("nope", { status: 404, statusText: "Not Found" });
      }
      if (url.includes("throws")) {
        throw new Error("offline");
      }
      const response = new Response(enc("JPEGDATA"));
      Object.defineProperty(response, "url", {
        value: "https://cdn.example/final/photo%20one.jpg",
      });
      return response;
    });
    const ctx = setup();
    await runBootstrap(ctx, {
      blueprint: {
        items: [
          {
            title: "Item A",
            media: [
              { type: "url", url: "https://example.org/photo.jpg?x=1" },
              { type: "url", url: "https://example.org/broken.png" },
              { type: "html", html: "<p>skip</p>" },
              { url: "   " },
            ],
          },
          {
            title: "Item B",
            media: [{ url: "https://example.org/throws.gif" }],
          },
        ],
      },
    });

    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "https://example.org/photo.jpg?x=1",
        "https://example.org/broken.png",
        "https://example.org/throws.gif",
      ],
    );
    const cached =
      "/persist/runtime/blueprint-media/item-1-media-1-photo_20one.jpg";
    assert.equal(readText(ctx.raw, cached), "JPEGDATA");

    const install = readText(ctx.raw, `${OMEKA_ROOT}/playground-install.php`);
    assert.ok(install.includes(`"cachedPath":"${cached}"`));
    assert.ok(install.includes('"cachedName":"photo_20one.jpg"'));
    const warnings = ctx.messages.filter((m) =>
      m.message.startsWith("[warning] Unable to prefetch"),
    );
    assert.deepEqual(
      warnings.map((m) => m.message),
      [
        '[warning] Unable to prefetch media "https://example.org/broken.png" for blueprint item "Item A": 404 Not Found',
        '[warning] Unable to prefetch media "https://example.org/throws.gif" for blueprint item "Item B": offline',
      ],
    );
  });
});
