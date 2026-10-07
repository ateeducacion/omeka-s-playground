import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDefaultBlueprint,
  buildEffectivePlaygroundConfig,
  exportBlueprintPayload,
  normalizeBlueprint,
  SHARED_BLUEPRINT_SCHEMA_URL,
} from "../src/shared/blueprint.js";
import { resolveCatalogRelease } from "../src/shared/omeka-catalog.js";

// The shared Omeka S blueprint format (omeka-s-contrib/omeka-s-blueprints, v0).

const baseConfig = {
  siteTitle: "Test Playground",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  admin: { username: "admin", email: "test@example.com", password: "admin" },
  landingPath: "/",
};

const normalize = (blueprint) => normalizeBlueprint(blueprint, baseConfig);
const moduleSource = (source, extra = {}) =>
  normalize({ modules: [{ name: "Foo", source, ...extra }] }).modules[0];

describe("add-on source string", () => {
  it("uses a ZIP URL as is", () => {
    assert.deepEqual(moduleSource("https://example.org/Foo-1.0.zip").source, {
      type: "url",
      url: "https://example.org/Foo-1.0.zip",
    });
  });

  it("turns gh:owner/repo into a GitHub archive of the ref, the version or HEAD", () => {
    const archive = (ref) => `https://github.com/owner/repo/archive/${ref}.zip`;
    assert.equal(moduleSource("gh:owner/repo").source.url, archive("HEAD"));
    assert.equal(
      moduleSource("gh:owner/repo", { version: "1.2.0" }).source.url,
      archive("1.2.0"),
    );
    assert.equal(
      moduleSource("gh:owner/repo#main", { version: "1.2.0" }).source.url,
      archive("main"),
    );
  });

  it("turns a GitHub repository URL into an archive", () => {
    assert.equal(
      moduleSource("https://github.com/owner/repo.git", { version: "v2" })
        .source.url,
      "https://github.com/owner/repo/archive/v2.zip",
    );
  });

  it("rejects source forms the Playground cannot fetch", () => {
    for (const source of [
      "git@github.com:owner/repo.git",
      "https://gitlab.com/group/repo.git",
      "composer:vendor/package",
    ]) {
      assert.throws(() => moduleSource(source), /not supported/u, source);
    }
  });

  it("without a source uses the add-on present or the omeka.org catalog, keeping the version", () => {
    const module = normalize({
      modules: [{ name: "Common", version: "3.4.60" }],
    }).modules[0];
    assert.deepEqual(module.source, { type: "bundled" });
    assert.equal(module.version, "3.4.60");
  });
});

describe("install and x-playground", () => {
  const blueprint = {
    install: {
      title: "Demo",
      locale: "en_US",
      timezone: "UTC",
      admin: { name: "Boss", email: "boss@example.com", password: "secret" },
    },
    users: [{ email: "editor@example.com", password: "x", role: "editor" }],
    "x-playground": {
      landingPage: "admin/item",
      debug: { enabled: true },
      phpConstants: { MY_FLAG: true },
    },
  };

  it("reads the install values and makes install.admin the first user", () => {
    const result = normalize(blueprint);
    assert.equal(result.siteOptions.title, "Demo");
    assert.equal(result.siteOptions.locale, "en_US");
    assert.deepEqual(
      result.users.map((user) => [user.email, user.username, user.role]),
      [
        ["boss@example.com", "Boss", "global_admin"],
        // the display name defaults to the email, as in Omeka-S-Cli
        ["editor@example.com", "editor@example.com", "editor"],
      ],
    );
    assert.deepEqual(result.login, {
      email: "boss@example.com",
      password: "secret",
    });
  });

  it("takes the admin password from the configuration when install.admin has none", () => {
    const result = normalize({ install: { admin: { email: "a@b.c" } } });
    assert.equal(result.users[0].password, "admin");
  });

  it("takes the configured password for any user without one (it is optional)", () => {
    const result = normalize({
      install: { admin: { name: "Admin", email: "admin@example.com" } },
      users: [{ email: "editor@example.com", role: "editor" }],
    });
    assert.equal(result.users[1].email, "editor@example.com");
    assert.equal(result.users[1].password, "admin");
  });

  it("puts the configured administrator first when the blueprint declares none", () => {
    const result = normalize({
      users: [{ email: "editor@example.com", role: "editor" }],
    });
    assert.deepEqual(
      result.users.map((user) => [user.email, user.role]),
      [
        ["test@example.com", "global_admin"],
        ["editor@example.com", "editor"],
      ],
    );
    assert.equal(result.login.email, "test@example.com");
  });

  it("merges install.admin with a user that has the same email", () => {
    const result = normalize({
      install: { admin: { email: "boss@example.com" } },
      users: [
        { username: "boss", email: "boss@example.com", password: "pw" },
        { email: "editor@example.com", password: "x" },
      ],
    });
    assert.equal(result.users.length, 2);
    assert.equal(result.users[0].password, "pw");
    assert.equal(result.users[0].role, "global_admin");
  });

  it("reads the runtime settings from x-playground, before the legacy keys", () => {
    const result = normalize({ ...blueprint, landingPage: "/ignored" });
    assert.equal(result.landingPage, "/admin/item");
    assert.equal(result.debug.enabled, true);
    assert.deepEqual(result.phpConstants, { MY_FLAG: true });
  });

  it("uses x-playground.login for autologin", () => {
    const result = normalize({
      ...blueprint,
      "x-playground": {
        login: { email: "editor@example.com", password: "x" },
      },
    });
    const effective = buildEffectivePlaygroundConfig(baseConfig, result);
    assert.equal(effective.admin.email, "editor@example.com");
  });
});

describe("files", () => {
  it("normalizes files and rejects destinations outside the Omeka S root", () => {
    const result = normalize({
      files: [
        { source: "https://example.org/a.php", destination: "config/a.php" },
        {
          source: "https://example.org/b.zip",
          destination: "modules/Foo/asset",
          extract: true,
        },
      ],
    });
    assert.deepEqual(result.files, [
      {
        source: "https://example.org/a.php",
        destination: "config/a.php",
        extract: false,
      },
      {
        source: "https://example.org/b.zip",
        destination: "modules/Foo/asset",
        extract: true,
      },
    ]);
    for (const destination of ["/etc/x", "../x", "config/../../x", "C:/x"]) {
      assert.throws(
        () => normalize({ files: [{ source: "./x", destination }] }),
        /destination/u,
        destination,
      );
    }
  });
});

describe("roles", () => {
  it("keeps module-defined roles as written and still maps the legacy aliases", () => {
    const result = normalize({
      users: [
        { email: "a@b.c", password: "x", role: "admin" },
        { email: "d@e.f", password: "x", role: "Guest_Private" },
      ],
    });
    assert.deepEqual(
      result.users.map((user) => user.role),
      ["global_admin", "Guest_Private"],
    );
  });
});

describe("normalization is idempotent", () => {
  it("gives the same result when normalized twice (shell, then runtime)", () => {
    const input = {
      install: { title: "Demo", admin: { email: "boss@example.com" } },
      modules: [
        "Common",
        { name: "Foo", source: "gh:owner/foo", version: "1.0" },
      ],
      files: [
        { source: "https://example.org/a.php", destination: "config/a.php" },
      ],
      sites: [{ title: "Demo", slug: "demo" }],
      "x-playground": { landingPage: "/admin" },
    };
    const once = normalize(input);
    assert.deepEqual(normalize(once), once);
  });
});

describe("export", () => {
  it("writes the shared format", () => {
    const exported = exportBlueprintPayload(
      baseConfig,
      normalize({
        siteOptions: { title: "Legacy" },
        login: { email: "test@example.com", password: "admin" },
        landingPage: "/admin",
        site: { title: "Site", slug: "site" },
        modules: [
          { name: "Foo", source: { type: "url", url: "https://e.org/f.zip" } },
          { name: "Bar", source: { type: "omeka.org", slug: "Bar" } },
        ],
      }),
    );
    assert.equal(exported.$schema, SHARED_BLUEPRINT_SCHEMA_URL);
    for (const key of [
      "siteOptions",
      "login",
      "landingPage",
      "site",
      "debug",
    ]) {
      assert.equal(key in exported, false, key);
    }
    assert.equal(exported.install.title, "Legacy");
    assert.equal(exported.install.admin.email, "test@example.com");
    assert.equal(exported["x-playground"].landingPage, "/admin");
    assert.deepEqual(
      exported.sites.map((site) => site.slug),
      ["site"],
    );
    assert.deepEqual(exported.modules, [
      { name: "Foo", state: "activate", source: "https://e.org/f.zip" },
      { name: "Bar", state: "activate" },
    ]);
  });

  it("round-trips through normalization", () => {
    const normalized = normalize({
      install: { title: "Demo" },
      modules: [{ name: "Foo", source: "https://e.org/f.zip" }],
    });
    const again = normalize(exportBlueprintPayload(baseConfig, normalized));
    assert.deepEqual(again.modules, normalized.modules);
    assert.equal(again.siteOptions.title, "Demo");
  });
});

describe("buildDefaultBlueprint", () => {
  it("uses the shared format", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.equal(result.$schema, SHARED_BLUEPRINT_SCHEMA_URL);
    assert.equal(result.install.title, "Test Playground");
    assert.equal(result["x-playground"].landingPage, "/admin");
    assert.equal("siteOptions" in result, false);
  });
});

describe("resolveCatalogRelease", () => {
  const catalog = {
    foundation: {
      dirname: "foundation",
      latest_version: "1.6.0",
      versions: {
        "1.5.0": { download_url: "https://e.org/foundation-1.5.0.zip" },
        "1.6.0": { download_url: "https://e.org/foundation-1.6.0.zip" },
      },
    },
  };

  it("finds the add-on by name, case-insensitively, at the latest or the requested version", () => {
    assert.equal(
      resolveCatalogRelease(catalog, "Foundation"),
      "https://e.org/foundation-1.6.0.zip",
    );
    assert.equal(
      resolveCatalogRelease(catalog, "foundation", "v1.5.0"),
      "https://e.org/foundation-1.5.0.zip",
    );
  });

  it("fails clearly for an unknown add-on or version", () => {
    assert.throws(() => resolveCatalogRelease(catalog, "Nope"), /Nope/u);
    assert.throws(
      () => resolveCatalogRelease(catalog, "foundation", "9.9"),
      /9\.9/u,
    );
  });
});
