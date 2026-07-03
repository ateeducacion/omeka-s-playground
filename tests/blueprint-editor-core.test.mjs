import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBlueprintRunUrl,
  createBlueprintValidationResult,
  escapeHtml,
  formatBlueprintText,
  getInitialBlueprintCode,
  highlightJson,
} from "../src/shell/blueprint-editor-core.js";

describe("escapeHtml", () => {
  it("escapes ampersands, angle brackets and double quotes", () => {
    assert.strictEqual(
      escapeHtml(`<a href="x">Tom & Jerry</a>`),
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  it("escapes single quotes", () => {
    assert.strictEqual(escapeHtml("it's"), "it&#39;s");
  });

  it("returns an empty string for non-string input", () => {
    assert.strictEqual(escapeHtml(undefined), "");
    assert.strictEqual(escapeHtml(null), "");
  });
});

describe("highlightJson", () => {
  it("wraps object keys in a key token class", () => {
    const html = highlightJson('{"name": "value"}');
    assert.match(html, /<span class="bp-tok-key">&quot;name&quot;<\/span>/);
  });

  it("wraps string values in a string token class", () => {
    const html = highlightJson('{"name": "value"}');
    assert.match(html, /<span class="bp-tok-string">&quot;value&quot;<\/span>/);
  });

  it("wraps numbers in a number token class", () => {
    const html = highlightJson('{"count": 42}');
    assert.match(html, /<span class="bp-tok-number">42<\/span>/);
  });

  it("wraps booleans in a boolean token class", () => {
    const html = highlightJson('{"active": true}');
    assert.match(html, /<span class="bp-tok-boolean">true<\/span>/);
  });

  it("wraps null in a null token class", () => {
    const html = highlightJson('{"value": null}');
    assert.match(html, /<span class="bp-tok-null">null<\/span>/);
  });

  it("escapes HTML-sensitive characters inside string values", () => {
    const html = highlightJson('{"html": "<b>&"}');
    assert.match(html, /&lt;b&gt;&amp;/);
    assert.doesNotMatch(html, /<b>/);
  });

  it("returns an empty string for empty input", () => {
    assert.strictEqual(highlightJson(""), "");
  });

  it("tolerates malformed JSON without throwing", () => {
    assert.doesNotThrow(() => highlightJson('{"broken": '));
  });
});

describe("formatBlueprintText", () => {
  it("pretty-prints valid JSON with 2-space indentation", () => {
    assert.strictEqual(
      formatBlueprintText('{"steps":[{"step":"login"}]}'),
      '{\n  "steps": [\n    {\n      "step": "login"\n    }\n  ]\n}',
    );
  });

  it("throws for malformed JSON", () => {
    assert.throws(() => formatBlueprintText("{invalid"));
  });
});

describe("getInitialBlueprintCode", () => {
  it("pretty-prints valid JSON text", () => {
    assert.strictEqual(
      getInitialBlueprintCode('{"steps":[]}'),
      '{\n  "steps": []\n}',
    );
  });

  it("returns the raw text unchanged when JSON is malformed", () => {
    assert.strictEqual(getInitialBlueprintCode("not json"), "not json");
  });

  it("returns an empty string for blank or non-string input", () => {
    assert.strictEqual(getInitialBlueprintCode(""), "");
    assert.strictEqual(getInitialBlueprintCode("   "), "");
    assert.strictEqual(getInitialBlueprintCode(undefined), "");
  });
});

describe("createBlueprintValidationResult", () => {
  // Mirrors this repo's src/shared/blueprint.js normalizeBlueprint contract:
  // permissive for object input, throws for non-object JSON.
  const normalizeBlueprint = (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Blueprint must be a JSON object.");
    }
    return input;
  };

  it("reports an empty-input error without calling normalizeBlueprint", () => {
    let called = false;
    const result = createBlueprintValidationResult("   ", {
      normalizeBlueprint: () => {
        called = true;
      },
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.stage, "json");
    assert.strictEqual(called, false);
  });

  it("reports a JSON stage error for malformed JSON", () => {
    const result = createBlueprintValidationResult("{not valid", {
      normalizeBlueprint,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.stage, "json");
    assert.match(result.message, /Invalid JSON/);
  });

  it("reports a schema stage error when normalizeBlueprint throws", () => {
    const result = createBlueprintValidationResult('"just a string"', {
      normalizeBlueprint,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.stage, "schema");
    assert.match(result.message, /Blueprint must be a JSON object\./);
  });

  it("returns a valid result with the normalized blueprint", () => {
    const result = createBlueprintValidationResult('{"steps": []}', {
      normalizeBlueprint,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.stage, "valid");
    assert.deepStrictEqual(result.blueprint, { steps: [] });
  });
});

describe("buildBlueprintRunUrl", () => {
  it("sets the blueprint param and removes blueprint-url/blueprint-data", () => {
    const url = buildBlueprintRunUrl(
      "https://example.com/app/?blueprint-url=https://old.example/bp.json&blueprint-data=xyz&foo=bar",
      "ENCODED",
    );
    const parsed = new URL(url);
    assert.strictEqual(parsed.searchParams.get("blueprint"), "ENCODED");
    assert.strictEqual(parsed.searchParams.has("blueprint-url"), false);
    assert.strictEqual(parsed.searchParams.has("blueprint-data"), false);
    assert.strictEqual(parsed.searchParams.get("foo"), "bar");
  });

  it("preserves the origin and path", () => {
    const url = buildBlueprintRunUrl(
      "https://example.com/index.html?x=1",
      "abc",
    );
    assert.ok(url.startsWith("https://example.com/index.html?"));
  });
});
