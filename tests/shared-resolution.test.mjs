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
// What each shared error looks like in the Playground's messages.
const ERRORS = {
  "outside-root": "is outside the blueprint folder",
  "outside-repository": "which would leave its repository",
  "encoded-separator": 'has an encoded "/" or "\\"',
};
// A file in a repository, as the raw URL the Playground downloads.
function rawUrl({ repository, ref, path }) {
  const [host, ...rest] = repository.split("/");
  const at = ref || "HEAD";
  if (host === "github.com") {
    return `https://raw.githubusercontent.com/${rest.join("/")}/${at}/${path}`;
  }
  return `https://${repository}/-/raw/${at}/${path}`;
}
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

const segments = (pointer) =>
  pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));

function getPointer(document, pointer) {
  return segments(pointer).reduce((value, part) => value[part], document);
}

function setPointer(document, pointer, value) {
  const parts = segments(pointer);
  const last = parts.pop();
  parts.reduce((node, part) => node[part], document)[last] = value;
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
      // Each error on its own: the other erroneous values become harmless.
      const errors = expected.filter(({ resolved: want }) => want.error);
      for (const { in: file, pointer, resolved: want } of errors) {
        assert.ok(ERRORS[want.error], `unknown error ${want.error}`);
        const own = structuredClone(documents);
        for (const other of errors.filter(
          (e) => e.pointer !== pointer || e.in !== file,
        )) {
          setPointer(
            own[new URL(other.in, base).href],
            other.pointer,
            "./ok.zip",
          );
        }
        const value = getPointer(own[new URL(file, base).href], pointer);
        // Imports are resolved first; add-on sources are checked when normalized.
        await assert.rejects(
          async () =>
            normalizeBlueprint(
              await resolveBlueprintImports(own[`${base}blueprint.json`], {
                baseUrl: `${base}blueprint.json`,
                fetchJson: async (url) => own[url],
              }),
              config,
            ),
          (error) =>
            error.message.includes(`"${value}"`) &&
            error.message.includes(ERRORS[want.error]),
          `${file}${pointer}`,
        );
      }
      if (errors.length) {
        return;
      }
      // The Playground downloads GitHub repositories only; it skips the other
      // hosts, as the shared fixtures allow for a form a consumer does not support.
      const unsupported = ({ resolved: want }) =>
        want.repository &&
        !want.path &&
        !want.repository.startsWith("github.com/");
      for (const { in: file, pointer } of expected.filter(unsupported)) {
        setPointer(documents[new URL(file, base).href], pointer, "./ok.zip");
      }
      const blueprint = await resolve();
      const normalized = normalizeBlueprint(blueprint, config);
      const resolved = [...strings(blueprint), ...strings(normalized)];
      const addonUrls = normalized.modules.map((module) => module.source?.url);
      for (const { in: file, pointer, resolved: want } of expected) {
        const where = `${file}${pointer}`;
        if (!want.repository && (want.path || want.url)) {
          const url = want.url || new URL(want.path, base).href;
          assert.ok(resolved.includes(url), `${where}: ${url}`);
        } else if (want.repository && want.path) {
          const url = rawUrl(want);
          assert.ok(resolved.includes(url), `${where}: ${url}`);
        } else if (unsupported({ resolved: want })) {
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
