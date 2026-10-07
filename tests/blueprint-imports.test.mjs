import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  declaresSharedSchema,
  exportBlueprintPayload,
  loadBlueprintDocument,
  normalizeBlueprint,
  parseImportedBlueprintPayload,
  SHARED_BLUEPRINT_SCHEMA_URL,
} from "../src/shared/blueprint.js";
import {
  BlueprintImportError,
  BlueprintSchemaError,
  fetchJsonDocument,
  parseJsonc,
  resolveBlueprintImports,
  resolveReference,
  withoutImportReferences,
} from "../src/shared/blueprint-imports.js";
import * as schema from "../src/shared/blueprint-schema.js";

// `$import`, `vocabularies` and `resourceTemplates` of the shared Omeka S
// blueprint format, and the shared-schema validation.

const config = {
  siteTitle: "Test",
  locale: "en_US",
  timezone: "UTC",
  admin: { username: "admin", email: "admin@example.com", password: "pw" },
};
const ROOT = "https://example.org/repo/blueprint.json";

// A fake network: URL -> parsed JSON (or an Error to throw).
function fakeFetch(documents) {
  const fetched = [];
  const fetchJson = async (url) => {
    fetched.push(url);
    if (!(url in documents)) {
      throw new Error("HTTP 404");
    }
    const value = documents[url];
    if (value instanceof Error) {
      throw value;
    }
    return structuredClone(value);
  };
  return { fetchJson, fetched };
}

const load = (document, documents = {}, options = {}) =>
  loadBlueprintDocument(document, config, {
    baseUrl: ROOT,
    fetchJson: fakeFetch(documents).fetchJson,
    schema,
    ...options,
  });

const shared = (blueprint) => ({
  $schema: SHARED_BLUEPRINT_SCHEMA_URL,
  ...blueprint,
});

const vocabulary = (extra = {}) => ({
  prefix: "ex",
  namespaceUri: "https://example.org/ns#",
  label: "Example",
  source: "./vocab.ttl",
  ...extra,
});

describe("$import", () => {
  it("splices a relative import in place, resolved against the blueprint", async () => {
    const result = await load(
      { modules: ["A", { $import: "./partials/modules.json" }, "D"] },
      { "https://example.org/repo/partials/modules.json": ["B", "C"] },
    );
    assert.deepEqual(
      result.modules.map((module) => module.name),
      ["A", "B", "C", "D"],
    );
  });

  it("resolves nested imports and their assets against the file that declares them", async () => {
    const result = await load(
      { vocabularies: [{ $import: "./partials/vocabularies.json" }] },
      {
        "https://example.org/repo/partials/vocabularies.json": [
          { $import: "../shared/more.json" },
          vocabulary({ source: "rdf/ex.ttl" }),
        ],
        "https://example.org/repo/shared/more.json": vocabulary({
          prefix: "other",
          namespaceUri: "https://example.org/other#",
          source: "./other.rdf",
        }),
      },
    );
    assert.deepEqual(
      result.vocabularies.map((entry) => entry.source),
      [
        "https://example.org/repo/shared/other.rdf",
        "https://example.org/repo/partials/rdf/ex.ttl",
      ],
    );
  });

  it("resolves relative sources of inline entries against the blueprint URL", async () => {
    const result = await load({
      files: [{ source: "./config/a.php", destination: "config/a.php" }],
      resourceTemplates: [{ source: "templates/book.json" }],
      vocabularies: [vocabulary()],
    });
    assert.equal(
      result.files[0].source,
      "https://example.org/repo/config/a.php",
    );
    assert.equal(
      result.resourceTemplates[0].source,
      "https://example.org/repo/templates/book.json",
    );
    assert.equal(
      result.vocabularies[0].source,
      "https://example.org/repo/vocab.ttl",
    );
  });

  it("imports absolute URLs and GitHub file references from a blueprint without URL", async () => {
    const { fetchJson, fetched } = fakeFetch({
      "https://cdn.example.org/themes.json": ["freedom"],
      "https://raw.githubusercontent.com/owner/repo/v1/users.json": [
        { email: "e@example.org" },
      ],
    });
    const result = await loadBlueprintDocument(
      {
        themes: [{ $import: "https://cdn.example.org/themes.json#ignored" }],
        users: [{ $import: "gh:owner/repo@v1:users.json" }],
      },
      config,
      { fetchJson },
    );
    assert.deepEqual(fetched, [
      "https://cdn.example.org/themes.json",
      "https://raw.githubusercontent.com/owner/repo/v1/users.json",
    ]);
    assert.equal(result.themes[0].name, "freedom");
    assert.equal(result.users.at(-1).email, "e@example.org");
  });

  it("converts repository references like Omeka-S-Cli", () => {
    assert.equal(
      resolveReference("https://github.com/o/r/blob/main/a/b.json#L3", null),
      "https://raw.githubusercontent.com/o/r/main/a/b.json",
    );
    assert.equal(
      resolveReference("gh:o/r:b.json", null),
      "https://raw.githubusercontent.com/o/r/HEAD/b.json",
    );
    assert.equal(
      resolveReference("gl:group/sub/r@v2:b.json", null),
      "https://gitlab.com/group/sub/r/-/raw/v2/b.json",
    );
    assert.equal(
      resolveReference("./x.json", "gh:o/r@v1:dir/blueprint.json"),
      "https://raw.githubusercontent.com/o/r/v1/dir/x.json",
    );
  });

  it("rejects a relative import when the blueprint has no URL", async () => {
    await assert.rejects(
      loadBlueprintDocument({ modules: [{ $import: "./m.json" }] }, config, {
        fetchJson: fakeFetch({}).fetchJson,
      }),
      (error) =>
        error instanceof BlueprintImportError &&
        /"\.\/m\.json" cannot be resolved/u.test(error.message),
    );
  });

  it("rejects schemes other than http(s)", () => {
    for (const reference of ["file:///etc/passwd", "data:,[]"]) {
      assert.throws(
        () => resolveReference(reference, ROOT),
        /unsupported scheme/u,
        reference,
      );
    }
  });

  it("detects cycles, naming the chain", async () => {
    await assert.rejects(
      load(
        { items: [{ $import: "a.json" }] },
        {
          "https://example.org/repo/a.json": [{ $import: "b.json" }],
          "https://example.org/repo/b.json": [{ $import: "./a.json" }],
        },
      ),
      {
        name: "BlueprintImportError",
        message:
          "Circular $import: https://example.org/repo/blueprint.json -> https://example.org/repo/a.json -> https://example.org/repo/b.json -> https://example.org/repo/a.json",
      },
    );
  });

  it("allows the same document to be imported twice without a cycle", async () => {
    const result = await load(
      { itemSets: [{ $import: "s.json" }], items: [{ $import: "s.json" }] },
      { "https://example.org/repo/s.json": [{ title: "T" }] },
    );
    assert.equal(result.itemSets[0].title, "T");
    assert.equal(result.items[0].title, "T");
  });

  it("reports failed downloads and invalid content with the source", async () => {
    await assert.rejects(
      load({ modules: [{ $import: "missing.json" }] }),
      /Unable to import https:\/\/example\.org\/repo\/missing\.json \(modules in https:\/\/example\.org\/repo\/blueprint\.json\): HTTP 404/u,
    );
    await assert.rejects(
      load(
        { modules: [{ $import: "n.json" }] },
        { "https://example.org/repo/n.json": 42 },
      ),
      /Imported modules document https:\/\/example\.org\/repo\/n\.json must be a JSON list or object/u,
    );
  });

  it("checks imported documents against the schema when the blueprint declares it", async () => {
    const documents = {
      "https://example.org/repo/v.json": [{ prefix: "ex" }],
    };
    await assert.rejects(
      load(shared({ vocabularies: [{ $import: "v.json" }] }), documents),
      (error) =>
        error instanceof BlueprintSchemaError &&
        error.message.includes("https://example.org/repo/v.json") &&
        error.message.includes("must have required property 'source'"),
    );
  });

  it("merges imported settings in order, nested ones included", async () => {
    const result = await load(
      {
        settings: [{ a: 1, b: 1 }, { $import: "settings.json" }, { c: 3 }],
      },
      {
        "https://example.org/repo/settings.json": [
          { b: 2, c: 2 },
          { $import: "more/settings.json" },
        ],
        "https://example.org/repo/more/settings.json": { d: 4 },
      },
    );
    assert.deepEqual(result.settings, { a: 1, b: 2, c: 3, d: 4 });
  });

  it("refuses an $import where the format does not allow one", () => {
    assert.throws(
      () => normalizeBlueprint({ sites: [{ $import: "s.json" }] }, config),
      /Blueprint sites has an unresolved \$import "s\.json"/u,
    );
    assert.throws(
      () => normalizeBlueprint({ settings: { $import: "s.json" } }, config),
      /unresolved \$import/u,
    );
  });

  it("leaves a blueprint without imports as it was", async () => {
    const document = { modules: ["A"], settings: { x: 1 } };
    assert.deepEqual(
      await resolveBlueprintImports(document, {
        fetchJson: fakeFetch({}).fetchJson,
      }),
      document,
    );
  });
});

describe("last one wins", () => {
  it("lets a later entry replace an imported one, taking the last position", async () => {
    const result = await load(
      {
        modules: [
          { $import: "modules.json" },
          { name: "common", version: "2" },
        ],
      },
      {
        "https://example.org/repo/modules.json": [
          { name: "Common", version: "1", state: "install" },
          "Log",
        ],
      },
    );
    assert.deepEqual(
      result.modules.map((module) => [
        module.name,
        module.version,
        module.state,
      ]),
      [
        ["Log", undefined, "activate"],
        // replaced, not merged: state is not kept from the earlier entry
        ["common", "2", "activate"],
      ],
    );
  });

  it("identifies vocabularies by namespace URI and templates by label or source", () => {
    const result = normalizeBlueprint(
      {
        vocabularies: [
          vocabulary({ label: "First" }),
          vocabulary({ prefix: "ex2", label: "Second" }),
        ],
        resourceTemplates: [
          { source: "https://e.org/a.json" },
          { source: "https://e.org/b.json", label: "Book" },
          { source: "https://e.org/a.json", ignoreDeps: true },
          { source: "https://e.org/c.json", label: "book" },
        ],
      },
      config,
    );
    assert.deepEqual(
      result.vocabularies.map((entry) => entry.label),
      ["Second"],
    );
    assert.deepEqual(
      result.resourceTemplates.map((entry) => [entry.source, entry.ignoreDeps]),
      [
        ["https://e.org/a.json", true],
        ["https://e.org/c.json", false],
      ],
    );
  });

  it("identifies users by email, files by destination and content by title", () => {
    const result = normalizeBlueprint(
      {
        users: [
          { email: "a@e.org", role: "editor" },
          { email: "a@e.org", role: "author" },
        ],
        files: [
          { source: "https://e.org/1", destination: "x" },
          { source: "https://e.org/2", destination: "x" },
        ],
        itemSets: [{ title: "S", description: "1" }, { title: "S" }],
        items: [
          { title: "I", creator: "1" },
          { title: "I", creator: "2" },
        ],
      },
      config,
    );
    assert.deepEqual(
      result.users.map((user) => user.role),
      ["author"],
    );
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].source, "https://e.org/2");
    assert.equal(result.itemSets.length, 1);
    assert.equal(result.itemSets[0].description, "");
    assert.equal(result.items[0].creator, "2");
  });
});

describe("vocabularies and resourceTemplates", () => {
  it("keeps every vocabulary field of the shared format", () => {
    const entry = vocabulary({
      source: "https://e.org/v.rdf",
      comment: "c",
      format: "rdfxml",
      lang: "en",
      labelProperty: "http://www.w3.org/2004/02/skos/core#prefLabel",
      commentProperty: "http://www.w3.org/2004/02/skos/core#definition",
    });
    const [normalized] = normalizeBlueprint(
      { vocabularies: [entry] },
      config,
    ).vocabularies;
    assert.deepEqual(normalized, entry);
  });

  it("requires source, namespaceUri, prefix and label", () => {
    for (const field of ["source", "namespaceUri", "prefix", "label"]) {
      assert.throws(
        () =>
          normalizeBlueprint(
            { vocabularies: [vocabulary({ [field]: "" })] },
            config,
          ),
        new RegExp(`requires "${field}"`, "u"),
      );
    }
    assert.throws(
      () => normalizeBlueprint({ resourceTemplates: [{ label: "x" }] }, config),
      /resource template requires "source"/u,
    );
  });

  it("normalizes idempotently and exports in the shared format", () => {
    const blueprint = {
      vocabularies: [vocabulary({ source: "https://e.org/v.ttl" })],
      resourceTemplates: [{ source: "https://e.org/t.json", label: "T" }],
    };
    const once = normalizeBlueprint(blueprint, config);
    assert.deepEqual(normalizeBlueprint(once, config), once);
    const exported = exportBlueprintPayload(config, blueprint);
    assert.deepEqual(exported.vocabularies, once.vocabularies);
    assert.deepEqual(exported.resourceTemplates, [
      { source: "https://e.org/t.json", label: "T", ignoreDeps: false },
    ]);
    assert.deepEqual(schema.validateBlueprintSchema(exported), []);
  });
});

describe("shared schema", () => {
  it("validates blueprints that declare the shared schema", async () => {
    assert.ok(declaresSharedSchema(shared({})));
    assert.ok(
      declaresSharedSchema({
        $schema:
          "https://omeka-s-contrib.github.io/omeka-s-blueprints/schema/v0.1.0/blueprint-schema.json",
      }),
    );
    await assert.rejects(
      load(shared({ siteOptions: { title: "Legacy key" } })),
      (error) =>
        error instanceof BlueprintSchemaError &&
        /must NOT have additional properties/u.test(error.message),
    );
  });

  it("only warns for the earlier Playground format", async () => {
    const result = await load({ siteOptions: { title: "Legacy key" } });
    assert.equal(result.siteOptions.title, "Legacy key");
  });

  it("keeps the local schema copy in step with the URL blueprints declare", () => {
    assert.equal(
      schema.SHARED_BLUEPRINT_SCHEMA_ID,
      SHARED_BLUEPRINT_SCHEMA_URL,
    );
  });

  it("validates the default blueprint export", () => {
    assert.deepEqual(
      schema.validateBlueprintSchema(exportBlueprintPayload(config, {})),
      [],
    );
  });
});

describe("editor and uploaded blueprints", () => {
  it("checks a document with absolute imports without fetching them", () => {
    const document = {
      modules: ["A", { $import: "https://e.org/m.json" }],
      settings: [{ $import: "https://e.org/s.json" }],
    };
    assert.deepEqual(withoutImportReferences(document), {
      modules: ["A"],
      settings: [],
    });
    const parsed = parseImportedBlueprintPayload(document, config);
    assert.equal(parsed.type, "blueprint");
    assert.deepEqual(parsed.blueprint, document);
  });

  it("rejects relative imports that could never be resolved", () => {
    assert.throws(
      () => withoutImportReferences({ items: [{ $import: "./i.json" }] }),
      /cannot be resolved/u,
    );
  });
});

describe("JSONC", () => {
  it("accepts comments and trailing commas, as Omeka-S-Cli does", () => {
    const text = `{
      // modules
      "modules": ["A", /* inline */ "B",],
      "meta": { "title": "a // not a comment, /* nor this */", },
      "settings": { "x": "quote \\" // still a string" }, // trailing
    }`;
    assert.deepEqual(parseJsonc(text), {
      modules: ["A", "B"],
      meta: { title: "a // not a comment, /* nor this */" },
      settings: { x: 'quote " // still a string' },
    });
  });

  it("still rejects what is not JSON", () => {
    for (const text of [
      "{ a: 1 }",
      "[1,,2]",
      "/* open",
      "[1] x",
      // a trailing comma needs a value before it
      "{,}",
      "[,]",
      "[ /* c */ , ]",
      "[1,,]",
      '{"a": {,}}',
    ]) {
      assert.throws(() => parseJsonc(text), SyntaxError, text);
    }
  });

  it("reads fetched blueprints and imports as JSONC", async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response('[ "A", // first\n "B", ]'),
    );
    assert.deepEqual(await fetchJsonDocument("https://e.org/m.jsonc"), [
      "A",
      "B",
    ]);
  });
});
