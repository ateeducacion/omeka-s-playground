import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  buildDefaultBlueprint,
  clearActiveBlueprint,
  decodeBlueprintParam,
  encodeBlueprintParam,
  exportBlueprintPayload,
  loadActiveBlueprint,
  loadBlueprintDocument,
  normalizeBlueprint,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
  SHARED_BLUEPRINT_SCHEMA_URL,
  saveActiveBlueprint,
} from "../src/shared/blueprint.js";
import { SNAPSHOT_VERSION } from "../src/shared/protocol.js";
import { stubFetch } from "./helpers/fake-php.mjs";

const config = {
  siteTitle: "Test Playground",
  locale: "en_US",
  timezone: "UTC",
  admin: { username: "admin", email: "admin@example.com", password: "pw" },
  landingPath: "/admin",
};

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

describe("encodeBlueprintParam / decodeBlueprintParam", () => {
  it("gzips large blueprints and decodes them back", async () => {
    const blueprint = buildDefaultBlueprint(config);
    const encoded = await encodeBlueprintParam(blueprint);
    // base64url of the gzip magic 1f 8b 08
    assert.ok(encoded.startsWith("H4sI"));
    assert.doesNotMatch(encoded, /[+/=]/);
    assert.deepEqual(await decodeBlueprintParam(encoded), blueprint);
  });

  it("keeps tiny payloads as plain base64url JSON", async () => {
    const encoded = await encodeBlueprintParam({ a: 1 });
    assert.equal(Buffer.from(encoded, "base64url").toString(), '{"a":1}');
    assert.deepEqual(await decodeBlueprintParam(encoded), { a: 1 });
  });

  it("falls back to plain JSON without CompressionStream or when it throws", async (t) => {
    const original = globalThis.CompressionStream;
    t.after(() => {
      globalThis.CompressionStream = original;
    });
    const blueprint = buildDefaultBlueprint(config);
    const plain = Buffer.from(JSON.stringify(blueprint)).toString("base64url");

    globalThis.CompressionStream = undefined;
    assert.equal(await encodeBlueprintParam(blueprint), plain);

    globalThis.CompressionStream = function Broken() {
      throw new Error("unsupported");
    };
    assert.equal(await encodeBlueprintParam(blueprint), plain);
  });

  it("accepts standard base64 with whitespace and JSONC", async () => {
    const encoded = base64('{"a": 1, // note\n}');
    assert.deepEqual(
      await decodeBlueprintParam(
        ` ${encoded.slice(0, 4)}\n${encoded.slice(4)}`,
      ),
      { a: 1 },
    );
  });

  it("rejects empty, non-base64, non-UTF-8 and non-JSON payloads", async () => {
    await assert.rejects(decodeBlueprintParam(""), /empty/);
    await assert.rejects(decodeBlueprintParam("@@@"), /not valid base64/);
    await assert.rejects(
      decodeBlueprintParam(base64([0xff, 0xfe, 0xfd])),
      /not valid UTF-8/,
    );
    await assert.rejects(
      decodeBlueprintParam(base64("{nope")),
      /not valid JSON/,
    );
  });
});

describe("normalizeBlueprint edge cases", () => {
  it("drops invalid sites and falls back for a non-string landing page", () => {
    const result = normalizeBlueprint(
      {
        sites: [
          null,
          { slug: "no-title" },
          { title: "Real", slug: "Bad Slug!" },
        ],
        landingPage: 42,
      },
      config,
    );
    assert.deepEqual(
      result.sites.map((site) => [site.title, site.slug, site.setAsDefault]),
      [["Real", "bad-slug", true]],
    );
    assert.equal(result.landingPage, "/admin");
  });

  it("resolves addon source shapes and rejects incomplete ones", () => {
    const result = normalizeBlueprint(
      {
        modules: [
          { name: "Blank", source: "   " },
          { name: "Org", source: { slug: "org-module" } },
          {
            name: "Typed",
            source: { type: "URL", url: "https://x.test/a.zip" },
          },
          { name: "Gh", source: "gh:owner/repo#v1" },
          "",
        ],
      },
      config,
    );
    assert.deepEqual(
      result.modules.map((module) => module.source),
      [
        { type: "bundled" },
        { type: "omeka.org", slug: "org-module" },
        { type: "url", url: "https://x.test/a.zip" },
        { type: "url", url: "https://github.com/owner/repo/archive/v1.zip" },
      ],
    );

    const fails = (source, pattern) =>
      assert.throws(
        () => normalizeBlueprint({ modules: [{ name: "M", source }] }, config),
        pattern,
      );
    fails({ type: "url" }, /requires source.url/);
    fails({ type: "omeka.org" }, /requires source.slug/);
    fails({ type: "svn" }, /Unsupported blueprint addon source type "svn"/);
  });

  it("collapses repeated bare module names, warning when the later one differs", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const result = normalizeBlueprint(
      { modules: ["Mapping", "mapping"] },
      config,
    );
    assert.deepEqual(
      result.modules.map((module) => module.name),
      ["mapping"],
    );
    assert.equal(warn.mock.callCount(), 1);
    normalizeBlueprint({ modules: ["Mapping", "Mapping"] }, config);
    assert.equal(warn.mock.callCount(), 1);
  });

  it("fills item, permission, module-state and version defaults", () => {
    const result = normalizeBlueprint(
      {
        sites: [{ title: "S", permissions: [{ email: "e@x.test" }] }],
        modules: [{ name: "M", state: "  " }],
        items: [
          {
            title: "Item",
            description: "Desc",
            itemSets: ["Set", ""],
            sites: ["s", null],
            media: [{ url: "https://x.test/i.png", altText: "Alt" }],
          },
          { title: "  " },
        ],
      },
      config,
    );
    assert.deepEqual(result.sites[0].permissions, [
      { user: "e@x.test", role: "viewer" },
    ]);
    assert.equal(result.modules[0].state, "activate");
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.items[0].itemSets, ["Set"]);
    assert.deepEqual(result.items[0].sites, ["s"]);
    assert.equal(result.items[0].media[0].altText, "Alt");

    const fromRuntimes = buildDefaultBlueprint({
      ...config,
      runtimes: [
        { phpVersion: "8.1", omekaVersion: "4.1.1" },
        { phpVersion: "8.4", omekaVersion: "4.2.1", default: true },
      ],
    });
    assert.deepEqual(fromRuntimes.preferredVersions, {
      php: "8.4",
      omeka: "4.2.1",
    });
    assert.deepEqual(
      buildDefaultBlueprint({
        ...config,
        runtimes: [{ phpVersion: "8.2", omekaVersion: "4.1.1" }],
      }).preferredVersions,
      { php: "8.2", omeka: "4.1.1" },
    );
  });

  it("rejects users without a password, empty destinations and unnamed vocabularies", () => {
    assert.throws(
      () =>
        normalizeBlueprint(
          { users: [{ email: "a@x.test", role: "global_admin" }] },
          { ...config, admin: { ...config.admin, password: "" } },
        ),
      /must include email and password/,
    );
    assert.throws(
      () => normalizeBlueprint({ files: [{ source: "a" }] }, config),
      /destination ""/,
    );
    assert.throws(
      () =>
        normalizeBlueprint(
          { vocabularies: [{ namespaceUri: "urn:x" }] },
          config,
        ),
      /vocabulary "urn:x" requires "source"/,
    );
    assert.throws(
      () => normalizeBlueprint({ vocabularies: [{}] }, config),
      /vocabulary "" requires "source"/,
    );
  });

  it("requires a source for each root file", () => {
    assert.throws(
      () => normalizeBlueprint({ files: [{ destination: "a/b.txt" }] }, config),
      /requires a source/,
    );
  });
});

describe("exportBlueprintPayload", () => {
  it("exports versions, URL sources, asset files, constants and a distinct login", () => {
    const payload = exportBlueprintPayload(config, {
      modules: [
        {
          name: "Mod",
          version: "1.2",
          source: "https://x.test/mod.zip",
          assets: [{ url: "https://x.test/a.zip", destination: "asset" }],
        },
      ],
      themes: [
        {
          name: "Theme",
          assets: [{ url: "https://x.test/t.zip", destination: "dist" }],
        },
      ],
      "x-playground": {
        phpConstants: { MY_FLAG: true },
        login: { email: "other@example.com", password: "x" },
      },
    });

    assert.deepEqual(payload.modules, [
      {
        name: "Mod",
        state: "activate",
        version: "1.2",
        source: "https://x.test/mod.zip",
      },
    ]);
    assert.deepEqual(payload.themes, [{ name: "Theme" }]);
    assert.deepEqual(payload.files, [
      {
        source: "https://x.test/a.zip",
        destination: "modules/Mod/asset",
        extract: true,
      },
      {
        source: "https://x.test/t.zip",
        destination: "themes/Theme/dist",
        extract: true,
      },
    ]);
    assert.deepEqual(payload["x-playground"].phpConstants, { MY_FLAG: true });
    assert.deepEqual(payload["x-playground"].login, {
      email: "other@example.com",
      password: "x",
    });
  });
});

describe("loadBlueprintDocument", () => {
  it("rejects a document that is not an object", async () => {
    await assert.rejects(loadBlueprintDocument([], config), /JSON object/);
  });
});

describe("parseImportedBlueprintPayload", () => {
  it("recognizes snapshot payloads and normalizes their path", () => {
    assert.deepEqual(
      parseImportedBlueprintPayload(
        { version: SNAPSHOT_VERSION, runtimeId: "rt", path: "admin/items" },
        config,
      ),
      { type: "snapshot", runtimeId: "rt", path: "/admin/items" },
    );
    assert.equal(
      parseImportedBlueprintPayload({ version: SNAPSHOT_VERSION }, {}).path,
      "/",
    );
  });

  it("validates a blueprint and returns the raw document", () => {
    const raw = { meta: { title: "x" } };
    assert.deepEqual(parseImportedBlueprintPayload(raw, config), {
      type: "blueprint",
      blueprint: raw,
    });
  });
});

describe("browser storage and shell resolution", () => {
  const storage = new Map();
  const setLocation = (href) => {
    globalThis.window.location.href = href;
  };

  before(() => {
    globalThis.window = {
      location: { href: "https://app.test/play/" },
      sessionStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
      },
    };
  });

  after(() => {
    delete globalThis.window;
  });

  it("saves, loads and clears the active blueprint per scope", () => {
    assert.equal(loadActiveBlueprint("s1"), null);
    saveActiveBlueprint("s1", { meta: { title: "One" } });
    assert.deepEqual(loadActiveBlueprint("s1"), { meta: { title: "One" } });
    assert.equal(loadActiveBlueprint("s2"), null);
    clearActiveBlueprint("s1");
    assert.equal(loadActiveBlueprint("s1"), null);
  });

  it("absolutizes relative media URLs against the page and keeps invalid ones", () => {
    const result = normalizeBlueprint(
      {
        items: [
          {
            title: "Item",
            media: [{ url: "./img.png" }, { source: "http://[bad" }],
          },
        ],
      },
      config,
    );
    assert.deepEqual(
      result.items[0].media.map((media) => media.url),
      ["https://app.test/play/img.png", "http://[bad"],
    );
  });

  it("decodes an inline ?blueprint= and stores it for the scope", async () => {
    const encoded = await encodeBlueprintParam({ meta: { title: "Inline" } });
    setLocation(`https://app.test/play/?blueprint=${encoded}`);
    const result = await resolveBlueprintForShell("inline", config);
    assert.equal(result.meta.title, "Inline");
    assert.equal(loadActiveBlueprint("inline").meta.title, "Inline");
  });

  it("fetches a URL passed through ?blueprint= and ?blueprint-url=", async (t) => {
    const calls = stubFetch(t, async (url) =>
      Response.json({ meta: { title: `From ${new URL(url).pathname}` } }),
    );
    setLocation(
      `https://app.test/play/?blueprint=${encodeURIComponent("https://bp.test/a.json")}`,
    );
    assert.equal(
      (await resolveBlueprintForShell("u1", config)).meta.title,
      "From /a.json",
    );
    setLocation("https://app.test/play/?blueprint-url=b.json");
    assert.equal(
      (await resolveBlueprintForShell("u2", config)).meta.title,
      "From /play/b.json",
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      ["https://bp.test/a.json", "https://app.test/play/b.json"],
    );
  });

  it("reports a failed blueprint download with its URL", async (t) => {
    stubFetch(t, async () => new Response("", { status: 404 }));
    setLocation("https://app.test/play/?blueprint-url=missing.json");
    await assert.rejects(
      resolveBlueprintForShell("u3", config),
      /Unable to load blueprint from missing\.json: HTTP 404/,
    );
  });

  it("accepts the deprecated ?blueprint-data= alias with a warning", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const encoded = await encodeBlueprintParam({ meta: { title: "Legacy" } });
    setLocation(`https://app.test/play/?blueprint-data=${encoded}`);
    assert.equal(
      (await resolveBlueprintForShell("d", config)).meta.title,
      "Legacy",
    );
    assert.match(warn.mock.calls[0].arguments[0], /deprecated/);
  });

  it("loads the configured default blueprint URL, else the built-in default", async (t) => {
    stubFetch(t, async () => Response.json({ meta: { title: "Configured" } }));
    setLocation("https://app.test/play/");
    assert.equal(
      (
        await resolveBlueprintForShell("c", {
          ...config,
          defaultBlueprintUrl: "./default.json",
        })
      ).meta.title,
      "Configured",
    );
    const fallback = await resolveBlueprintForShell("f", config);
    assert.equal(fallback.$schema, SHARED_BLUEPRINT_SCHEMA_URL);
    assert.deepEqual(loadActiveBlueprint("f"), fallback);
  });

  it("validates against the schema when a validator is given", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const encoded = await encodeBlueprintParam({ meta: { title: "Checked" } });
    setLocation(`https://app.test/play/?blueprint=${encoded}`);
    const schema = {
      validateBlueprintSchema: () => ["bad field"],
      validateBlueprintReferences: () => [],
      validateImportedDocument: () => [],
    };
    const result = await resolveBlueprintForShell("v", config, { schema });
    assert.equal(result.meta.title, "Checked");
    assert.match(warn.mock.calls[0].arguments[0], /bad field/);
  });
});

describe("without a window", () => {
  it("storage helpers are no-ops and the shell gets the default blueprint", async () => {
    assert.equal(saveActiveBlueprint("x", {}), undefined);
    assert.equal(loadActiveBlueprint("x"), null);
    assert.equal(clearActiveBlueprint("x"), undefined);
    assert.deepEqual(
      await resolveBlueprintForShell("x", config),
      buildDefaultBlueprint(config),
    );
  });
});
