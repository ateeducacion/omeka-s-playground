import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDefaultBlueprint,
  buildEffectivePlaygroundConfig,
  normalizeBlueprint,
} from "../src/shared/blueprint.js";

const baseConfig = {
  siteTitle: "Test Playground",
  locale: "es_ES",
  timezone: "Europe/Madrid",
  admin: { username: "admin", email: "test@example.com", password: "admin" },
  landingPath: "/",
};

describe("normalizeBlueprint", () => {
  it("returns defaults when called with empty object", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.equal(result.siteOptions.title, "Test Playground");
    assert.equal(result.siteOptions.locale, "es_ES");
    assert.equal(result.siteOptions.timezone, "Europe/Madrid");
    assert.equal(result.landingPage, "/admin");
  });

  it("returns defaults when called with null", () => {
    const result = normalizeBlueprint(null, baseConfig);
    assert.equal(result.siteOptions.title, "Test Playground");
    assert.equal(result.users.length, 1);
  });

  it("preserves custom siteOptions", () => {
    const result = normalizeBlueprint(
      {
        siteOptions: {
          title: "Mi Mediateca",
          locale: "ca_ES",
          timezone: "Atlantic/Canary",
        },
      },
      baseConfig,
    );
    assert.equal(result.siteOptions.title, "Mi Mediateca");
    assert.equal(result.siteOptions.locale, "ca_ES");
    assert.equal(result.siteOptions.timezone, "Atlantic/Canary");
  });

  it("normalizes landingPage with leading slash", () => {
    const result = normalizeBlueprint(
      { landingPage: "admin/item" },
      baseConfig,
    );
    assert.equal(result.landingPage, "/admin/item");
  });

  it("sets debug.enabled to false by default", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.equal(result.debug.enabled, false);
  });

  it("sets debug.enabled to true only when explicitly true", () => {
    const result = normalizeBlueprint({ debug: { enabled: true } }, baseConfig);
    assert.equal(result.debug.enabled, true);
  });

  it("creates default user from config", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].username, "admin");
    assert.equal(result.users[0].email, "test@example.com");
    assert.equal(result.users[0].role, "global_admin");
    assert.equal(result.users[0].isActive, true);
  });

  it("normalizes user roles", () => {
    const result = normalizeBlueprint(
      {
        users: [
          {
            email: "admin@example.com",
            password: "pass",
            role: "Admin",
          },
        ],
      },
      baseConfig,
    );
    assert.equal(result.users[0].role, "global_admin");
  });

  it("falls back to config defaults for first user missing email", () => {
    const result = normalizeBlueprint(
      { users: [{ password: "pass" }] },
      baseConfig,
    );
    assert.equal(result.users[0].email, "test@example.com");
  });

  it("falls back to config defaults for first user missing password", () => {
    const result = normalizeBlueprint(
      { users: [{ email: "a@b.com" }] },
      baseConfig,
    );
    assert.equal(result.users[0].password, "admin");
  });

  it("throws on second user without email", () => {
    assert.throws(
      () =>
        normalizeBlueprint(
          {
            users: [
              { email: "admin@example.com", password: "pass" },
              { password: "pass2" },
            ],
          },
          baseConfig,
        ),
      /must include email and password/u,
    );
  });

  it("normalizes themes as addon collection", () => {
    const result = normalizeBlueprint(
      { themes: [{ name: "MyTheme" }] },
      baseConfig,
    );
    assert.equal(result.themes.length, 1);
    assert.equal(result.themes[0].name, "MyTheme");
    assert.deepEqual(result.themes[0].source, { type: "bundled" });
  });

  it("normalizes modules with state", () => {
    const result = normalizeBlueprint(
      { modules: [{ name: "Mapping", state: "activate" }] },
      baseConfig,
    );
    assert.equal(result.modules.length, 1);
    assert.equal(result.modules[0].name, "Mapping");
    assert.equal(result.modules[0].state, "activate");
  });

  it("throws on duplicate module names", () => {
    assert.throws(
      () =>
        normalizeBlueprint(
          {
            modules: [{ name: "Foo" }, { name: "Foo" }],
          },
          baseConfig,
        ),
      /duplicate entry/u,
    );
  });

  it("throws on addon name with path separator", () => {
    assert.throws(
      () => normalizeBlueprint({ modules: [{ name: "foo/bar" }] }, baseConfig),
      /single path segment/u,
    );
  });

  it("normalizes itemSets", () => {
    const result = normalizeBlueprint(
      {
        itemSets: [
          { title: "Collection A", description: "Desc A" },
          { title: "Collection B" },
        ],
      },
      baseConfig,
    );
    assert.equal(result.itemSets.length, 2);
    assert.equal(result.itemSets[0].title, "Collection A");
    assert.equal(result.itemSets[0].description, "Desc A");
    assert.equal(result.itemSets[1].description, "");
  });

  it("filters out itemSets without title", () => {
    const result = normalizeBlueprint(
      { itemSets: [{ description: "no title" }] },
      baseConfig,
    );
    assert.equal(result.itemSets.length, 0);
  });

  it("normalizes items with media", () => {
    const result = normalizeBlueprint(
      {
        items: [
          {
            title: "Test Item",
            media: [{ url: "https://example.com/img.png", title: "Img" }],
          },
        ],
      },
      baseConfig,
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "Test Item");
    assert.equal(result.items[0].media.length, 1);
    assert.equal(result.items[0].media[0].type, "url");
  });

  it("normalizes site section when present", () => {
    const result = normalizeBlueprint(
      { site: { title: "My Site", theme: "classic" } },
      baseConfig,
    );
    assert.equal(result.site.title, "My Site");
    assert.equal(result.site.slug, "my-site");
    assert.equal(result.site.theme, "classic");
    assert.equal(result.site.isPublic, true);
  });

  it("sets site to null when not provided", () => {
    const result = normalizeBlueprint({}, baseConfig);
    assert.equal(result.site, null);
  });
});

describe("buildDefaultBlueprint", () => {
  it("includes meta section", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.ok(result.meta);
    assert.equal(result.meta.author, "omeka-s-playground");
  });

  it("includes preferredVersions", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.ok(result.preferredVersions.php);
    assert.ok(result.preferredVersions.omeka);
  });

  it("uses config values for siteOptions", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.equal(result.siteOptions.title, "Test Playground");
    assert.equal(result.siteOptions.locale, "es_ES");
    assert.equal(result.siteOptions.timezone, "Europe/Madrid");
  });

  it("creates default user from config.admin", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].username, "admin");
    assert.equal(result.users[0].email, "test@example.com");
    assert.equal(result.users[0].role, "global_admin");
  });

  it("includes a default item set and item", () => {
    const result = buildDefaultBlueprint(baseConfig);
    assert.ok(result.itemSets.length > 0);
    assert.ok(result.items.length > 0);
  });
});

describe("buildEffectivePlaygroundConfig", () => {
  it("merges blueprint into config", () => {
    const blueprint = normalizeBlueprint(
      {
        siteOptions: { title: "Overridden Title" },
      },
      baseConfig,
    );
    const effective = buildEffectivePlaygroundConfig(baseConfig, blueprint);
    assert.equal(effective.siteTitle, "Overridden Title");
    assert.equal(effective.locale, "es_ES");
  });

  it("uses primary user as admin", () => {
    const blueprint = normalizeBlueprint(
      {
        users: [
          {
            username: "superadmin",
            email: "super@example.com",
            password: "secret",
            role: "global_admin",
          },
        ],
      },
      baseConfig,
    );
    const effective = buildEffectivePlaygroundConfig(baseConfig, blueprint);
    assert.equal(effective.admin.username, "superadmin");
    assert.equal(effective.admin.email, "super@example.com");
  });
});
