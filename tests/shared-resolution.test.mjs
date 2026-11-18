import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { normalizeBlueprint } from "../src/shared/blueprint.js";
import { resolveBlueprintImports } from "../src/shared/blueprint-imports.js";

// The shared resolution fixtures (omeka-s-contrib/omeka-s-blueprints,
// fixtures/resolution, copied to tests/fixtures/shared-resolution). Each case is
// served from https://example.test/<case>/ and resolved as a blueprint URL.

const DIR = new URL("./fixtures/shared-resolution/", import.meta.url).pathname;
const config = {
  siteTitle: "Test",
  locale: "en_US",
  timezone: "UTC",
  admin: { username: "admin", email: "admin@example.com", password: "pw" },
};

function caseFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? caseFiles(path) : [path];
  });
}

function strings(value) {
  if (typeof value === "string") {
    return [value];
  }
  return value && typeof value === "object"
    ? Object.values(value).flatMap(strings)
    : [];
}

describe("shared resolution fixtures", () => {
  for (const name of readdirSync(DIR).filter((entry) =>
    statSync(join(DIR, entry)).isDirectory(),
  )) {
    it(name, async () => {
      const dir = join(DIR, name);
      const base = `https://example.test/${name}/`;
      const documents = Object.fromEntries(
        caseFiles(dir)
          .filter((path) => path.endsWith(".json"))
          .map((path) => [
            new URL(relative(dir, path), base).href,
            JSON.parse(readFileSync(path, "utf8")),
          ]),
      );
      const expected = documents[`${base}expected.json`];
      const resolve = () =>
        resolveBlueprintImports(documents[`${base}blueprint.json`], {
          baseUrl: `${base}blueprint.json`,
          fetchJson: async (url) => documents[url],
        });
      // A case with an error expectation stops at its first error.
      if (expected.some(({ resolved: want }) => want.error)) {
        assert.ok(
          expected.every(({ resolved: want }) => want.error === "outside-root"),
        );
        await assert.rejects(resolve, /outside the blueprint folder/u);
        return;
      }
      const blueprint = await resolve();
      const resolved = strings(blueprint);
      const addonUrls = normalizeBlueprint(blueprint, config).modules.map(
        (module) => module.source?.url,
      );
      for (const { in: file, pointer, resolved: want } of expected) {
        const where = `${file}${pointer}`;
        if (want.path || want.url) {
          const url = want.url || new URL(want.path, base).href;
          assert.ok(resolved.includes(url), `${where}: ${url}`);
        } else if (want.repository) {
          const [, owner, repo] = want.repository.split("/");
          const url = `https://github.com/${owner}/${repo}/archive/${want.ref || "HEAD"}.zip`;
          assert.ok(addonUrls.includes(url), `${where}: ${url}`);
        } else {
          assert.fail(`${where}: unknown expectation ${JSON.stringify(want)}`);
        }
      }
    });
  }
});
