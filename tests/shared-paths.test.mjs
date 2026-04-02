import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasBlueprintUrlOverride } from "../src/shared/paths.js";

describe("hasBlueprintUrlOverride", () => {
  it("detects ?blueprint= with inline base64", () => {
    assert.equal(
      hasBlueprintUrlOverride(
        new URL("https://example.com/?blueprint=eyJmb28iOiJiYXIifQ"),
      ),
      true,
    );
  });

  it("detects ?blueprint= with a URL value (backward compat)", () => {
    assert.equal(
      hasBlueprintUrlOverride(
        new URL(
          "https://example.com/?blueprint=https%3A%2F%2Fexample.com%2Fblueprint.json",
        ),
      ),
      true,
    );
  });

  it("detects ?blueprint-url= (remote URL — explicit)", () => {
    assert.equal(
      hasBlueprintUrlOverride(
        new URL(
          "https://example.com/?blueprint-url=https%3A%2F%2Fexample.com%2Fb.json",
        ),
      ),
      true,
    );
  });

  it("detects ?blueprint-data= (legacy alias)", () => {
    assert.equal(
      hasBlueprintUrlOverride(
        new URL("https://example.com/?blueprint-data=eyJmb28iOiJiYXIifQ"),
      ),
      true,
    );
  });

  it("returns false for bare URL without blueprint params", () => {
    assert.equal(
      hasBlueprintUrlOverride(new URL("https://example.com/")),
      false,
    );
  });

  it("returns false for unrelated query params", () => {
    assert.equal(
      hasBlueprintUrlOverride(new URL("https://example.com/?debug=true")),
      false,
    );
  });
});
