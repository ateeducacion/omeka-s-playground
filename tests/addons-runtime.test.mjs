import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zipSync } from "fflate";

import {
  materializeBlueprintAddons,
  materializeBlueprintFiles,
  materializeBlueprintSources,
  mountPersistedAddons,
} from "../src/runtime/addons.js";
import { createFakeFs, stubFetch } from "./helpers/fake-php.mjs";

const OMEKA = "/www/omeka";
const PROXY = "https://proxy.test/addons";
const enc = (text) => new TextEncoder().encode(text);

function fakePhp(files = {}) {
  const FS = createFakeFs(files);
  return { FS, php: { binary: Promise.resolve({ FS }) } };
}

function zip(entries) {
  const flat = {};
  for (const [name, content] of Object.entries(entries)) {
    flat[name] = typeof content === "string" ? enc(content) : content;
  }
  return zipSync(flat);
}

function read(FS, path) {
  return FS.readFile(path, { encoding: "utf8" });
}

function exists(FS, path) {
  return FS.analyzePath(path).exists;
}

// Route stubbed fetches by URL; the proxy wraps the real URL in `?url=`.
function router(t, routes) {
  return stubFetch(t, async (url) => {
    const target = url.startsWith(PROXY)
      ? new URL(url).searchParams.get("url")
      : url;
    const route = routes[target];
    if (route === undefined) {
      return new Response("missing", { status: 404 });
    }
    if (typeof route === "function") {
      return route(url);
    }
    return new Response(route);
  });
}

function collector() {
  const messages = [];
  const publish = (message) => messages.push(message);
  return { messages, publish };
}

const proxyConfig = { addonProxyUrl: PROXY };

describe("mountPersistedAddons", () => {
  it("copies persisted modules and blueprint files onto the rebuilt core", async () => {
    const { FS, php } = fakePhp({
      "/persist/addons/modules/Mapping/Module.php": "<?php // mapping",
      "/persist/addons/modules/stray.txt": "not an addon",
      "/www/omeka/modules/Mapping/stale.php": "old",
      "/persist/addons/files/logo": "PNG",
      "/persist/addons/files/bundle/a/b.txt": "extracted",
      "/persist/addons/manifests/files.json": JSON.stringify({
        files: [
          {
            persistedPath: "/persist/addons/files/logo",
            destination: "files/logo.png",
          },
          {
            persistedPath: "/persist/addons/files/bundle",
            destination: "themes/extra",
            extract: true,
          },
          { persistedPath: "/persist/addons/files/gone", destination: "x" },
        ],
      }),
    });

    await mountPersistedAddons({ php, omekaRoot: OMEKA });

    assert.equal(
      read(FS, "/www/omeka/modules/Mapping/Module.php"),
      "<?php // mapping",
    );
    assert.equal(exists(FS, "/www/omeka/modules/Mapping/stale.php"), false);
    assert.equal(exists(FS, "/www/omeka/modules/stray.txt"), false);
    assert.deepEqual(FS.readdir("/www/omeka/themes"), [".", "..", "extra"]);
    assert.equal(read(FS, "/www/omeka/files/logo.png"), "PNG");
    assert.equal(read(FS, "/www/omeka/themes/extra/a/b.txt"), "extracted");
    assert.equal(exists(FS, "/www/omeka/x"), false);
  });

  it("does nothing when nothing was persisted", async () => {
    const { FS, php } = fakePhp();
    await mountPersistedAddons({ php, omekaRoot: OMEKA });
    assert.deepEqual(FS.readdir("/"), [".", ".."]);
  });
});

describe("materializeBlueprintAddons", () => {
  it("keeps a bundled module the core already ships without fetching", async (t) => {
    const calls = router(t, {});
    const { php } = fakePhp({
      "/www/omeka/modules/Common/Module.php": "<?php",
    });
    const { publish } = collector();

    const summary = await materializeBlueprintAddons({
      php,
      blueprint: { modules: [{ name: "Common" }] },
      omekaRoot: OMEKA,
      publish,
      config: {},
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(summary.modules, [
      {
        kind: "module",
        name: "Common",
        source: {
          type: "bundled",
          fingerprint: "bundled:Common",
          downloadUrl: null,
          pageUrl: null,
          slug: null,
        },
        mountPath: "/www/omeka/modules/Common",
        persistedPath: null,
        cached: true,
      },
    ]);
    assert.deepEqual(summary.themes, []);
  });

  it("resolves a missing bundled module through the catalog, then reuses the cache", async (t) => {
    const catalog = {
      Mapping: {
        dirname: "Mapping",
        latest_version: "2.0.0",
        versions: {
          "2.0.0": {
            download_url:
              "https://github.com/omeka-s-modules/Mapping/releases/Mapping-2.0.0.zip",
          },
        },
      },
    };
    const calls = router(t, {
      "https://omeka.org/add-ons/json/s_module.json": JSON.stringify(catalog),
      "https://github.com/omeka-s-modules/Mapping/releases/Mapping-2.0.0.zip":
        () =>
          new Response(
            zip({
              "Mapping/Module.php": "<?php // v2",
              "Mapping/config/module.ini": "[info]",
            }),
          ),
    });
    const { FS, php } = fakePhp();
    const { messages, publish } = collector();
    const args = {
      php,
      blueprint: { modules: [{ name: "Mapping" }] },
      omekaRoot: OMEKA,
      publish,
      config: proxyConfig,
    };

    const first = await materializeBlueprintAddons(args);

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.url.startsWith(`${PROXY}?url=`), call.url);
    }
    assert.equal(first.modules[0].cached, false);
    assert.equal(first.modules[0].source.type, "omeka.org-catalog");
    assert.equal(
      read(FS, "/www/omeka/modules/Mapping/Module.php"),
      "<?php // v2",
    );
    assert.equal(
      read(FS, "/persist/addons/modules/Mapping/config/module.ini"),
      "[info]",
    );
    const manifest = JSON.parse(
      read(FS, "/persist/addons/manifests/modules/Mapping.json"),
    );
    assert.equal(manifest.fingerprint, "catalog:module:Mapping:latest");
    assert.deepEqual(messages, [
      'Fetching module "Mapping".',
      'Extracting module "Mapping".',
    ]);

    // The core is rebuilt on every boot: the mount is gone, the cache is not.
    FS.rename("/www/omeka/modules/Mapping", "/trash");
    const second = await materializeBlueprintAddons(args);
    assert.equal(
      calls.length,
      2,
      "a cached add-on does not refetch the catalog",
    );
    assert.equal(second.modules[0].cached, true);
    assert.equal(
      read(FS, "/www/omeka/modules/Mapping/Module.php"),
      "<?php // v2",
    );
  });

  it("downloads URL themes and overlays asset archives at their destination", async (t) => {
    const calls = router(t, {
      "https://example.test/theme.zip": () =>
        new Response(
          zip({
            "__MACOSX/._x": "junk",
            "Foo-main/": new Uint8Array(0),
            "Foo-main/theme.ini": "name=Foo",
            "Foo-main/assets/": new Uint8Array(0),
            "Foo-main/.DS_Store": "junk",
          }),
        ),
      "https://example.test/static.zip": () =>
        new Response(
          zip({ "static/index.html": "<html>", "static/js/app.js": "1" }),
        ),
    });
    const { FS, php } = fakePhp();
    const { messages, publish } = collector();

    const summary = await materializeBlueprintAddons({
      php,
      blueprint: {
        themes: [
          {
            name: "Foo",
            source: { type: "url", url: "https://example.test/theme.zip" },
            assets: [
              {
                url: "https://example.test/static.zip",
                destination: "dist/editor",
              },
              { url: "", destination: "ignored" },
            ],
          },
        ],
      },
      omekaRoot: OMEKA,
      publish,
      config: {},
    });

    assert.deepEqual(
      calls.map((call) => call.url),
      ["https://example.test/theme.zip", "https://example.test/static.zip"],
    );
    assert.equal(summary.themes[0].mountPath, "/www/omeka/themes/Foo");
    assert.equal(read(FS, "/www/omeka/themes/Foo/theme.ini"), "name=Foo");
    assert.ok(
      FS.isDir(FS.analyzePath("/www/omeka/themes/Foo/assets").object.mode),
    );
    assert.equal(exists(FS, "/www/omeka/themes/Foo/.DS_Store"), false);
    assert.equal(exists(FS, "/persist/addons/themes/Foo/__MACOSX"), false);
    assert.equal(
      read(FS, "/www/omeka/themes/Foo/dist/editor/index.html"),
      "<html>",
    );
    assert.equal(read(FS, "/www/omeka/themes/Foo/dist/editor/js/app.js"), "1");
    const manifest = JSON.parse(
      read(FS, "/persist/addons/manifests/themes/Foo.json"),
    );
    assert.equal(
      manifest.fingerprint,
      "url:https://example.test/theme.zip|assets:https://example.test/static.zip->dist/editor",
    );
    assert.ok(messages.includes('Fetching asset for theme "Foo".'));
  });

  it("re-extracts when the cached fingerprint no longer matches", async (t) => {
    router(t, {
      "https://example.test/new.zip": () =>
        new Response(zip({ "M/new.php": "new" })),
    });
    const { FS, php } = fakePhp({
      "/persist/addons/modules/M/old.php": "old",
      "/persist/addons/manifests/modules/M.json": JSON.stringify({
        fingerprint: "url:https://example.test/old.zip",
      }),
    });

    await materializeBlueprintAddons({
      php,
      blueprint: {
        modules: [
          {
            name: "M",
            source: { type: "url", url: "https://example.test/new.zip" },
          },
        ],
      },
      omekaRoot: OMEKA,
      publish: () => {},
      config: {},
    });

    assert.equal(exists(FS, "/persist/addons/modules/M/old.php"), false);
    assert.equal(read(FS, "/www/omeka/modules/M/new.php"), "new");
  });

  it("resolves omeka.org pages, preferring the link labelled Download", async (t) => {
    const calls = router(t, {
      "https://omeka.org/s/modules/CSVImport/": `
        <a href="/other.zip">Changelog</a>
        <a class="button" href="https://github.com/x/CSVImport-2.6.zip"><span>Download</span> 2.6</a>`,
      "https://omeka.org/s/themes/Freedom/": `<a href="">empty</a><a href="files/Freedom-1.0.zip">Get it</a>`,
      "https://github.com/x/CSVImport-2.6.zip": () =>
        new Response(zip({ "CSVImport/Module.php": "csv" })),
      "https://omeka.org/s/themes/Freedom/files/Freedom-1.0.zip": () =>
        new Response(zip({ "Freedom/theme.ini": "freedom" })),
    });
    const { FS, php } = fakePhp();

    const summary = await materializeBlueprintAddons({
      php,
      blueprint: {
        modules: [
          {
            name: "CSVImport",
            source: { type: "omeka.org", slug: "CSVImport" },
          },
        ],
        themes: [
          { name: "Freedom", source: { type: "omeka.org", slug: "Freedom" } },
        ],
      },
      omekaRoot: OMEKA,
      publish: () => {},
      config: proxyConfig,
    });

    assert.equal(
      calls[0].url,
      `${PROXY}?url=${encodeURIComponent("https://omeka.org/s/modules/CSVImport/")}`,
    );
    assert.equal(
      summary.modules[0].source.downloadUrl,
      "https://github.com/x/CSVImport-2.6.zip",
    );
    assert.equal(
      summary.themes[0].source.fingerprint,
      "omeka.org:theme:Freedom:https://omeka.org/s/themes/Freedom/files/Freedom-1.0.zip",
    );
    assert.equal(read(FS, "/www/omeka/modules/CSVImport/Module.php"), "csv");
    assert.equal(read(FS, "/www/omeka/themes/Freedom/theme.ini"), "freedom");
  });

  it("reports unusable sources and archives", async (t) => {
    router(t, {
      "https://omeka.org/s/modules/Broken/": () =>
        new Response("down", { status: 500 }),
      "https://omeka.org/s/modules/NoLink/": "<p>no archive here</p>",
      "https://example.test/empty.zip": () =>
        new Response(zip({ "Mod/": new Uint8Array(0) })),
      "https://example.test/evil.zip": () =>
        new Response(zip({ "Mod/ok.php": "ok", "Mod/../../evil.php": "evil" })),
      "https://example.test/ok.zip": () =>
        new Response(zip({ "Mod/ok.php": "ok" })),
    });

    const cases = [
      [
        { name: "X", source: { type: "url" } },
        /Missing download URL for module "X"/,
      ],
      [
        { name: "X", source: { type: "omeka.org" } },
        /Missing omeka.org slug for module/,
      ],
      [
        { name: "X", source: { type: "omeka.org", slug: "Broken" } },
        /Unable to load .*Broken\/: 500/,
      ],
      [
        { name: "X", source: { type: "omeka.org", slug: "NoLink" } },
        /No download link found/,
      ],
      [
        { name: "X", source: { type: "git" } },
        /Unsupported addon source type "git"/,
      ],
      [
        {
          name: "X",
          source: { type: "url", url: "https://example.test/missing.zip" },
        },
        /Unable to download .*: 404/,
      ],
      [
        {
          name: "X",
          source: { type: "url", url: "https://example.test/empty.zip" },
        },
        /did not contain any installable files/,
      ],
      [
        {
          name: "X",
          source: { type: "url", url: "https://example.test/evil.zip" },
        },
        /unsafe path "\.\.\/\.\.\/evil\.php"/,
      ],
      [
        {
          name: "X",
          source: { type: "url", url: "https://example.test/ok.zip" },
          assets: [
            { url: "https://example.test/ok.zip", destination: "../../escape" },
          ],
        },
        /Unsafe add-on asset destination/,
      ],
    ];
    for (const [spec, expected] of cases) {
      const { php } = fakePhp();
      await assert.rejects(
        materializeBlueprintAddons({
          php,
          blueprint: { modules: [spec] },
          omekaRoot: OMEKA,
          publish: () => {},
          config: {},
        }),
        expected,
      );
    }
  });

  it("retries once on a transient 503 and wraps network failures", async (t) => {
    let attempts = 0;
    router(t, {
      "https://example.test/flaky.zip": () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 503 })
          : new Response(zip({ "M/a.php": "a" }));
      },
      "https://example.test/offline.zip": () => {
        throw new TypeError("network down");
      },
      "https://example.test/dies.zip": () => {
        attempts += 1;
        if (attempts > 3) throw new TypeError("gone");
        return new Response("bad gateway", { status: 502 });
      },
    });
    const run = (url) =>
      materializeBlueprintAddons({
        php: fakePhp().php,
        blueprint: { modules: [{ name: "M", source: { type: "url", url } }] },
        omekaRoot: OMEKA,
        publish: () => {},
        config: {},
      });

    const summary = await run("https://example.test/flaky.zip");
    assert.equal(attempts, 2);
    assert.equal(summary.modules[0].cached, false);
    await assert.rejects(
      run("https://example.test/offline.zip"),
      /Unable to download .*offline\.zip: network down/,
    );
    await assert.rejects(
      run("https://example.test/dies.zip"),
      /Unable to download .*dies\.zip: gone/,
    );
  });

  it("patches EasyAdmin to read its catalogs from a local cache", async (t) => {
    const addonsPhp = [
      "$a = 'https://omeka.org/add-ons/json/s_module.json';",
      "$b = 'https://omeka.org/add-ons/json/s_theme.json';",
      "$c = 'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_modules.csv';",
      "$d = 'https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_themes.csv';",
      "$e = @file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_selections.csv');",
      "    protected function fileGetContents($url): ?string\n    {\n        $uri = new HttpUri($url);\n        $this->httpClient->reset();\n        $this->httpClient->setUri($uri);\n        try {\n            $response = $this->httpClient->send();\n            $response = $response->isOk() ? $response->getBody() : null;\n        } catch (RuntimeException $e) {\n            $response = null;\n        }\n",
    ].join("\n");
    const formFactory =
      "$s = @file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/refs/heads/master/_data/omeka_s_selections.csv');";
    const sessionSql =
      "DELETE `session` FROM `session` WHERE `modified` < :time;";
    const routes = {
      "https://example.test/easyadmin.zip": () =>
        new Response(
          zip({
            "EasyAdmin/src/Mvc/Controller/Plugin/Addons.php": addonsPhp,
            "EasyAdmin/src/Service/Form/AddonsFormFactory.php": formFactory,
            "EasyAdmin/src/Job/CronTasks.php": sessionSql,
            "EasyAdmin/src/Job/DbSession.php": sessionSql,
            "EasyAdmin/Module.php": sessionSql,
          }),
        ),
    };
    for (const name of ["s_module.json", "s_theme.json"]) {
      routes[`https://omeka.org/add-ons/json/${name}`] = `{"${name}":1}`;
    }
    for (const name of [
      "omeka_s_modules.csv",
      "omeka_s_themes.csv",
      "omeka_s_selections.csv",
    ]) {
      routes[
        `https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/${name}`
      ] = `csv:${name}`;
    }
    const calls = router(t, routes);
    const { FS, php } = fakePhp();
    const { messages, publish } = collector();
    const args = {
      php,
      blueprint: {
        modules: [
          {
            name: "EasyAdmin",
            source: { type: "url", url: "https://example.test/easyadmin.zip" },
          },
        ],
      },
      omekaRoot: OMEKA,
      publish,
      config: proxyConfig,
    };

    await materializeBlueprintAddons(args);

    assert.equal(calls.length, 6);
    const root = "/www/omeka/modules/EasyAdmin";
    assert.equal(
      read(FS, `${root}/data/playground-cache/s_theme.json`),
      '{"s_theme.json":1}',
    );
    assert.equal(
      read(FS, `${root}/data/playground-cache/omeka_s_selections.csv`),
      "csv:omeka_s_selections.csv",
    );
    const patched = read(FS, `${root}/src/Mvc/Controller/Plugin/Addons.php`);
    assert.doesNotMatch(
      patched,
      /'https:\/\/(omeka\.org|raw\.githubusercontent)/,
    );
    assert.match(patched, /data\/playground-cache' \. '\/s_module\.json'/);
    assert.match(
      patched,
      /@file_get_contents\(OMEKA_PATH .* '\/omeka_s_selections\.csv'\)/,
    );
    assert.match(patched, /preg_match\('~\^https\?:\/\/~i'/);
    assert.match(
      read(FS, `${root}/src/Service/Form/AddonsFormFactory.php`),
      /playground-cache' \. '\/omeka_s_selections\.csv'/,
    );
    for (const file of [
      "src/Job/CronTasks.php",
      "src/Job/DbSession.php",
      "Module.php",
    ]) {
      assert.equal(
        read(FS, `${root}/${file}`),
        "DELETE FROM `session` WHERE `modified` < :time;",
      );
    }
    assert.ok(
      messages.includes(
        "Applying EasyAdmin-specific catalog compatibility patch.",
      ),
    );

    // Cached add-on and catalog files: the reboot only re-patches and re-mounts.
    await materializeBlueprintAddons(args);
    assert.equal(calls.length, 6);
  });

  it("patches the refs/heads selections URL in the EasyAdmin form factory", async (t) => {
    router(t, {
      "https://example.test/ea.zip": () =>
        new Response(
          zip({
            "EasyAdmin/src/Service/Form/AddonsFormFactory.php":
              "@file_get_contents('https://raw.githubusercontent.com/Daniel-KM/UpgradeToOmekaS/master/_data/omeka_s_selections.csv')",
            "EasyAdmin/data/playground-cache/s_module.json": "{}",
            "EasyAdmin/data/playground-cache/s_theme.json": "{}",
            "EasyAdmin/data/playground-cache/omeka_s_modules.csv": "",
            "EasyAdmin/data/playground-cache/omeka_s_themes.csv": "",
            "EasyAdmin/data/playground-cache/omeka_s_selections.csv": "",
          }),
        ),
    });
    const { FS, php } = fakePhp();
    await materializeBlueprintAddons({
      php,
      blueprint: {
        modules: [
          {
            name: "EasyAdmin",
            source: { type: "url", url: "https://example.test/ea.zip" },
          },
        ],
      },
      omekaRoot: OMEKA,
      publish: () => {},
      config: {},
    });
    assert.match(
      read(
        FS,
        "/www/omeka/modules/EasyAdmin/src/Service/Form/AddonsFormFactory.php",
      ),
      /^@file_get_contents\(OMEKA_PATH/,
    );
    assert.equal(exists(FS, "/www/omeka/modules/EasyAdmin/src/Mvc"), false);
  });
});

describe("materializeBlueprintFiles", () => {
  it("caches files under /persist, overlays them, and drops removed ones", async (t) => {
    let downloads = 0;
    router(t, {
      "https://example.test/logo.png": () => {
        downloads += 1;
        return new Response("PNG");
      },
      "https://example.test/pack.zip": () => {
        downloads += 1;
        return new Response(zip({ "pack/a.txt": "A", "pack/b/c.txt": "C" }));
      },
    });
    const { FS, php } = fakePhp();
    const { messages, publish } = collector();
    const blueprint = {
      files: [
        {
          source: "https://example.test/logo.png",
          destination: "files/asset/logo.png",
          extract: false,
        },
        {
          source: "https://example.test/pack.zip",
          destination: "themes/default/pack",
          extract: true,
        },
      ],
    };
    const args = { php, blueprint, omekaRoot: OMEKA, publish, config: {} };

    const files = await materializeBlueprintFiles(args);

    assert.equal(downloads, 2);
    assert.deepEqual(
      files.map((file) => [file.persistedPath, file.fingerprint]),
      [
        [
          "/persist/addons/files/files-asset-logo.png",
          "https://example.test/logo.png|extract:false",
        ],
        [
          "/persist/addons/files/themes-default-pack",
          "https://example.test/pack.zip|extract:true",
        ],
      ],
    );
    assert.equal(read(FS, "/www/omeka/files/asset/logo.png"), "PNG");
    assert.equal(read(FS, "/www/omeka/themes/default/pack/b/c.txt"), "C");
    assert.deepEqual(messages, [
      'Fetching file "files/asset/logo.png".',
      'Fetching file "themes/default/pack".',
    ]);

    await materializeBlueprintFiles(args);
    assert.equal(downloads, 2, "cached files are not downloaded again");

    await materializeBlueprintFiles({
      ...args,
      blueprint: { files: [blueprint.files[0]] },
    });
    assert.equal(
      exists(FS, "/persist/addons/files/themes-default-pack"),
      false,
    );
    const manifest = JSON.parse(
      read(FS, "/persist/addons/manifests/files.json"),
    );
    assert.equal(manifest.files.length, 1);
  });

  it("bypasses the proxy for same-origin and unparsable sources, keeping multi-root archives intact", async (t) => {
    const calls = stubFetch(
      t,
      async () =>
        new Response(zip({ "A/x.txt": "x", A: "root file", "B/y.txt": "y" })),
    );
    const { FS, php } = fakePhp();

    await materializeBlueprintFiles({
      php,
      blueprint: {
        files: [
          { source: "assets/pack.zip", destination: "local", extract: true },
          { source: "http://[bad", destination: "bad", extract: true },
        ],
      },
      omekaRoot: OMEKA,
      publish: () => {},
      config: proxyConfig,
    });

    assert.equal(
      calls[0].url,
      new URL("../assets/pack.zip", import.meta.url).href,
    );
    assert.equal(calls[1].url, "http://[bad");
    assert.equal(read(FS, "/www/omeka/local/x.txt"), "x");
    assert.equal(
      read(FS, "/www/omeka/local/B/y.txt"),
      "y",
      "a second root keeps its folder",
    );
    assert.equal(exists(FS, "/www/omeka/local/A"), false);
  });

  it("rejects an unsafe destination before downloading", async (t) => {
    const calls = router(t, {});
    await assert.rejects(
      materializeBlueprintFiles({
        php: fakePhp().php,
        blueprint: {
          files: [
            { source: "https://example.test/x", destination: "../etc/passwd" },
          ],
        },
        omekaRoot: OMEKA,
        publish: () => {},
        config: {},
      }),
      /Unsafe add-on asset destination/,
    );
    assert.equal(calls.length, 0);
  });
});

describe("materializeBlueprintSources", () => {
  it("caches vocabulary and template sources by URL hash and prunes stale ones", async (t) => {
    const calls = router(t, {
      "https://schema.org/ttl": "@prefix schema: <https://schema.org/> .",
      "https://example.test/template.json": '{"o:label":"Book"}',
    });
    const { FS, php } = fakePhp({ "/persist/addons/sources/stale": "old" });
    const { messages, publish } = collector();
    const blueprint = {
      vocabularies: [{ prefix: "schema", source: "https://schema.org/ttl" }],
      resourceTemplates: [{ source: "https://example.test/template.json" }],
    };

    const staged = await materializeBlueprintSources({
      php,
      blueprint,
      publish,
      config: {},
    });

    assert.equal(
      blueprint.vocabularies[0].cachedPath,
      undefined,
      "input is not mutated",
    );
    const vocabularyPath = staged.vocabularies[0].cachedPath;
    assert.match(vocabularyPath, /^\/persist\/addons\/sources\/[0-9a-f]{32}$/);
    assert.equal(
      read(FS, vocabularyPath),
      "@prefix schema: <https://schema.org/> .",
    );
    assert.equal(
      read(FS, staged.resourceTemplates[0].cachedPath),
      '{"o:label":"Book"}',
    );
    assert.equal(exists(FS, "/persist/addons/sources/stale"), false);
    assert.deepEqual(messages, [
      'Fetching the vocabulary "schema" source.',
      'Fetching the resource template "https://example.test/template.json" source.',
    ]);

    await materializeBlueprintSources({ php, blueprint, publish, config: {} });
    assert.equal(calls.length, 2, "cached sources are reused");
  });

  it("falls back to the proxy when the direct download fails", async (t) => {
    const calls = stubFetch(t, async (url) =>
      url.startsWith(PROXY)
        ? new Response("rdf via proxy")
        : new Response("cors", { status: 403 }),
    );
    const { FS, php } = fakePhp();

    const staged = await materializeBlueprintSources({
      php,
      blueprint: {
        resourceTemplates: [
          { label: "Book", source: "https://nocors.test/t.json" },
        ],
      },
      publish: () => {},
      config: proxyConfig,
    });

    assert.equal(calls.length, 2);
    assert.equal(
      calls[1].url,
      `${PROXY}?url=${encodeURIComponent("https://nocors.test/t.json")}`,
    );
    assert.equal(
      read(FS, staged.resourceTemplates[0].cachedPath),
      "rdf via proxy",
    );
  });

  it("names the entry when no download succeeds", async (t) => {
    stubFetch(t, async () => new Response("no", { status: 404 }));
    const args = {
      php: fakePhp().php,
      blueprint: {
        vocabularies: [{ prefix: "dc", source: "https://dc.test/terms" }],
      },
      publish: () => {},
    };

    await assert.rejects(
      materializeBlueprintSources({ ...args, config: {} }),
      /Blueprint vocabulary "dc": unable to download https:\/\/dc\.test\/terms \(Unable to download https:\/\/dc\.test\/terms: 404\)/,
    );
    await assert.rejects(
      materializeBlueprintSources({ ...args, config: proxyConfig }),
      /Blueprint vocabulary "dc": unable to download .*proxy\.test.*: 404\)/,
    );
  });
});
