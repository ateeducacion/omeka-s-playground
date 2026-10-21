import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHARED_BLUEPRINT_SCHEMA_URL } from "../src/shared/blueprint.js";
import {
  buildScopeKey,
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../src/shared/storage.js";
import {
  APP_BASE,
  installBrowser,
  moduleControl,
} from "./helpers/shell-dom.mjs";

describe("shell session storage", () => {
  it("namespaces keys per scope", () => {
    assert.equal(buildScopeKey("abc", "state"), "omeka-playground:abc:state");
  });

  it("prefers ?scope= over the stored scope and remembers it", (t) => {
    const env = installBrowser(t, {
      url: `${APP_BASE}index.html?scope=from-url`,
      session: { "omeka-playground:active": "stored" },
      markup: false,
    });
    assert.equal(getOrCreateScopeId(), "from-url");
    assert.equal(
      env.window.sessionStorage.getItem("omeka-playground:active"),
      "from-url",
    );
  });

  it("reuses the tab's stored scope, else creates and stores a new one", (t) => {
    const env = installBrowser(t, { markup: false });
    const created = getOrCreateScopeId();
    assert.match(created, /^[0-9a-f-]{36}$/u);
    assert.equal(
      env.window.sessionStorage.getItem("omeka-playground:active"),
      created,
    );
    assert.equal(getOrCreateScopeId(), created);
  });

  it("round-trips state and clears only the scope's own keys", (t) => {
    const env = installBrowser(t, { markup: false });
    assert.equal(loadSessionState("s1"), null);
    saveSessionState("s1", { path: "/admin" });
    saveSessionState("s2", { path: "/" });
    env.window.sessionStorage.setItem("omeka-playground:s1:extra", "x");
    assert.deepEqual(loadSessionState("s1"), { path: "/admin" });

    clearScopeSession("s1");
    assert.equal(loadSessionState("s1"), null);
    assert.equal(
      env.window.sessionStorage.getItem("omeka-playground:s1:extra"),
      null,
    );
    assert.deepEqual(loadSessionState("s2"), { path: "/" });
  });
});

describe("loadBlueprintSchemaValidator", () => {
  it("loads the shared-schema bundle once, cache-busted by build", async () => {
    const { loadBlueprintSchemaValidator } = await import(
      "../src/shell/blueprint-schema-loader.js?loader-ok"
    );
    const first = loadBlueprintSchemaValidator();
    assert.equal(loadBlueprintSchemaValidator(), first);
    const validator = await first;
    assert.deepEqual(
      validator.validateBlueprintSchema({
        $schema: SHARED_BLUEPRINT_SCHEMA_URL,
      }),
      [],
    );
    assert.ok(
      validator.validateBlueprintSchema({
        $schema: SHARED_BLUEPRINT_SCHEMA_URL,
        modules: 5,
      }).length > 0,
    );
  });

  it("rejects when the bundle is missing", async () => {
    moduleControl.schema = "missing";
    try {
      const { loadBlueprintSchemaValidator } = await import(
        "../src/shell/blueprint-schema-loader.js?loader-missing"
      );
      await assert.rejects(loadBlueprintSchemaValidator(), /not built/u);
    } finally {
      moduleControl.schema = "ok";
    }
  });
});

describe("initBlueprintEditor without the schema bundle", () => {
  it("still checks JSON and normalization, skipping the shared schema", async (t) => {
    moduleControl.schema = "missing";
    moduleControl.codejar = "missing";
    const env = installBrowser(t, { markup: false });
    const { initBlueprintEditor } = await import(
      "../src/shell/blueprint-editor.js"
    );
    const { loadBlueprintSchemaValidator } = await import(
      "../src/shell/blueprint-schema-loader.js"
    );
    const editor = initBlueprintEditor(
      { textarea: null },
      { getConfig: () => env.config },
    );
    await assert.rejects(loadBlueprintSchemaValidator());
    editor.setCode(
      JSON.stringify({ $schema: SHARED_BLUEPRINT_SCHEMA_URL, modules: 5 }),
    );
    assert.equal(editor.getValidationResult().valid, true);
    editor.setCode("{");
    assert.equal(editor.getValidationResult().stage, "json");
  });
});
