import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasBlueprintUrlOverride,
  resolveRemoteUrl,
} from "../src/shared/paths.js";

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

describe("resolveRemoteUrl", () => {
  const withWindow = (fn) => {
    const previous = globalThis.window;
    globalThis.window = { location: { href: "https://example.com/app/?x=1" } };
    try {
      return fn();
    } finally {
      globalThis.window = previous;
    }
  };

  it("targets remote.html with scope, runtime and path", () => {
    const url = withWindow(() =>
      resolveRemoteUrl("s1", "php83-omeka421", "/admin"),
    );
    assert.equal(url.pathname, "/app/remote.html");
    assert.equal(url.searchParams.get("scope"), "s1");
    assert.equal(url.searchParams.get("runtime"), "php83-omeka421");
    assert.equal(url.searchParams.get("path"), "/admin");
    assert.equal(url.searchParams.has("opcache"), false);
  });

  it("forwards the experimental opcache flag only when set (ADR-0031)", () => {
    const on = withWindow(() =>
      resolveRemoteUrl("s1", "r", "/", { opcache: "1" }),
    );
    assert.equal(on.searchParams.get("opcache"), "1");
    const off = withWindow(() =>
      resolveRemoteUrl("s1", "r", "/", { opcache: null }),
    );
    assert.equal(off.searchParams.has("opcache"), false);
  });
});
