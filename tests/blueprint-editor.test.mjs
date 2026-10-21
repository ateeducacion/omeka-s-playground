import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeBlueprintParam,
  SHARED_BLUEPRINT_SCHEMA_URL,
} from "../src/shared/blueprint.js";
import {
  APP_BASE,
  installBrowser,
  moduleControl,
  waitFor,
} from "./helpers/shell-dom.mjs";

const { initBlueprintEditor } = await import(
  "../src/shell/blueprint-editor.js"
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, { codejar = "fail", text = "" } = {}) {
  moduleControl.codejar = codejar;
  const env = installBrowser(t);
  const elements = {
    mount: env.$("#blueprint-editor"),
    textarea: env.$("#blueprint-textarea"),
    statusEl: env.$("#blueprint-status"),
    runButton: env.$("#run-button"),
    copyButton: env.$("#copy-button"),
  };
  elements.textarea.value = text;
  const editor = initBlueprintEditor(elements, {
    location: env.location,
    getConfig: () => env.config,
  });
  return { env, editor, ...elements };
}

function type(textarea, value) {
  textarea.value = value;
  textarea.dispatchEvent(new textarea.ownerDocument.defaultView.Event("input"));
}

// The schema bundle loads asynchronously; a shared-schema error only shows up
// once it is in. Wait until the status reflects the validator.
async function schemaLoaded(editor) {
  await waitFor(() => {
    editor.setCode(
      JSON.stringify({ $schema: SHARED_BLUEPRINT_SCHEMA_URL, modules: 5 }),
    );
    return !editor.getValidationResult().valid;
  }, "schema validator");
}

describe("initBlueprintEditor (fallback textarea)", () => {
  it("validates as the user types and gates the Run button", async (t) => {
    const { editor, textarea, statusEl, runButton } = setup(t);
    assert.equal(textarea.readOnly, false);
    assert.equal(statusEl.textContent, "Blueprint cannot be empty.");
    assert.ok(statusEl.classList.contains("is-invalid"));
    assert.equal(runButton.disabled, true);

    type(textarea, "{ nope");
    assert.match(statusEl.textContent, /^Invalid JSON/u);
    assert.equal(editor.getCode(), "{ nope");

    type(textarea, "[1, 2]");
    assert.equal(
      statusEl.textContent,
      "Blueprint is invalid: Blueprint must be a JSON object.",
    );

    type(textarea, '{"landingPage": "/s/demo"}');
    assert.equal(statusEl.textContent, "✓ Valid blueprint");
    assert.ok(statusEl.classList.contains("is-valid"));
    assert.equal(runButton.disabled, false);
    assert.equal(editor.getValidationResult().blueprint.landingPage, "/s/demo");

    editor.setLocked(true);
    assert.equal(runButton.disabled, true);
    editor.setLocked(false);
    assert.equal(runButton.disabled, false);

    // The fallback textarea stays the visible editor without CodeJar.
    await flush();
    assert.equal(textarea.classList.contains("is-hidden"), false);
  });

  it("checks shared-schema blueprints once the validator bundle is in", async (t) => {
    const { editor, statusEl } = setup(t);
    await schemaLoaded(editor);
    assert.match(
      statusEl.textContent,
      /it is not valid against the shared format: \/modules must be array/u,
    );

    const withUnknownItemSet = {
      $schema: SHARED_BLUEPRINT_SCHEMA_URL,
      items: [{ title: "Item", itemSets: ["Ghost"] }],
    };
    editor.setCode(JSON.stringify(withUnknownItemSet));
    assert.match(statusEl.textContent, /references unknown item set 'Ghost'/u);

    // With $import entries the cross-references are left to run time.
    editor.setCode(
      JSON.stringify({
        ...withUnknownItemSet,
        itemSets: [{ $import: "https://example.test/sets.json" }],
      }),
    );
    assert.equal(statusEl.textContent, "✓ Valid blueprint");
  });

  it("runs the blueprint as written by reloading with ?blueprint=", async (t) => {
    const { env, editor, runButton, statusEl } = setup(t);
    editor.setCode(JSON.stringify({ landingPage: "/s/demo" }));
    runButton.click();
    assert.ok(statusEl.classList.contains("is-running"));
    assert.equal(runButton.disabled, true);
    await waitFor(() => env.location.assigned.length === 1, "navigation");
    const target = new URL(env.location.assigned[0]);
    assert.equal(target.href.startsWith(`${APP_BASE}index.html?`), true);
    assert.deepEqual(
      await decodeBlueprintParam(target.searchParams.get("blueprint")),
      { landingPage: "/s/demo" },
    );
  });

  it("does not run an invalid blueprint", async (t) => {
    const { env, editor, runButton, statusEl } = setup(t);
    editor.setCode("{");
    runButton.disabled = false;
    runButton.click();
    await flush();
    assert.equal(env.location.assigned.length, 0);
    assert.match(statusEl.textContent, /^Invalid JSON/u);
  });

  it("copies the code and flashes a confirmation", async (t) => {
    const { env, editor, copyButton } = setup(t);
    const originalHtml = copyButton.innerHTML;
    editor.setCode('{"a": 1}');
    t.mock.timers.enable({ apis: ["setTimeout"] });
    copyButton.click();
    await flush();
    assert.deepEqual(env.clipboard.writes, ['{"a": 1}']);
    assert.equal(copyButton.getAttribute("title"), "Copied!");
    assert.equal(copyButton.getAttribute("aria-label"), "Copied!");
    assert.match(copyButton.innerHTML, /<svg/u);
    t.mock.timers.tick(1200);
    assert.equal(copyButton.getAttribute("title"), "Copy blueprint JSON");
    assert.equal(copyButton.getAttribute("aria-label"), "Copy blueprint JSON");
    assert.equal(copyButton.innerHTML, originalHtml);
  });

  it("leaves the copy button alone when the clipboard refuses", async (t) => {
    const { env, copyButton } = setup(t);
    env.clipboard.fail = true;
    copyButton.click();
    await flush();
    assert.equal(copyButton.getAttribute("title"), "Copy blueprint JSON");
  });

  it("setCode resets non-string input and scrolls the textarea back", (t) => {
    const { editor, textarea } = setup(t, { text: '{"a": 1}' });
    assert.equal(editor.getValidationResult().valid, true);
    textarea.scrollTop = 40;
    editor.setCode(null);
    assert.equal(textarea.value, "");
    assert.equal(editor.getCode(), "");
    assert.equal(editor.getValidationResult().valid, false);
  });

  it("works without any optional element, reading the config live", (t) => {
    const env = installBrowser(t, { markup: false });
    moduleControl.codejar = "fail";
    let config;
    const editor = initBlueprintEditor(
      { textarea: null },
      { getConfig: () => config },
    );
    assert.equal(editor.getCode(), "");
    editor.setLocked(true);
    // Before main.js has loaded the config, normalization cannot succeed.
    editor.setCode('{"landingPage": "/"}');
    assert.equal(editor.getValidationResult().stage, "schema");
    config = env.config;
    editor.setCode('{"landingPage": "/"}');
    assert.equal(editor.getCode(), '{"landingPage": "/"}');
    assert.equal(editor.getValidationResult().valid, true);
  });
});

describe("initBlueprintEditor (CodeJar)", () => {
  it("takes over from the textarea, keeping focus and the hidden copy in sync", async (t) => {
    moduleControl.codejar = "ok";
    const env = installBrowser(t);
    const mount = env.$("#blueprint-editor");
    const textarea = env.$("#blueprint-textarea");
    textarea.value = '{"a": true}';
    textarea.focus();
    const editor = initBlueprintEditor(
      { mount, textarea, statusEl: env.$("#blueprint-status") },
      { location: env.location, getConfig: () => env.config },
    );
    await waitFor(() => !mount.classList.contains("is-hidden"), "CodeJar");

    assert.ok(textarea.classList.contains("is-hidden"));
    assert.equal(env.document.activeElement, mount);
    assert.deepEqual(globalThis.__codeJarInstances[0].options, { tab: "  " });
    assert.equal(mount.textContent, '{"a": true}');
    assert.match(mount.innerHTML, /<span class="bp-tok-boolean">true<\/span>/u);

    // Edits in CodeJar reach the hidden textarea; the textarea's own input
    // events no longer drive validation.
    mount.textContent = '{"b": 2}';
    mount.dispatchEvent(new env.happy.Event("input"));
    assert.equal(textarea.value, '{"b": 2}');
    assert.equal(editor.getCode(), '{"b": 2}');

    textarea.value = "{";
    textarea.dispatchEvent(new env.happy.Event("input"));
    assert.equal(editor.getValidationResult().valid, true);

    editor.setCode('{"c": null}');
    assert.equal(mount.textContent, '{"c": null}');
    assert.equal(editor.getCode(), '{"c": null}');
  });

  it("does not steal focus the textarea did not have", async (t) => {
    moduleControl.codejar = "ok";
    const env = installBrowser(t);
    const mount = env.$("#blueprint-editor");
    initBlueprintEditor(
      { mount, textarea: env.$("#blueprint-textarea") },
      { location: env.location },
    );
    await waitFor(() => !mount.classList.contains("is-hidden"), "CodeJar");
    assert.notEqual(env.document.activeElement, mount);
  });

  it("mounts without a fallback textarea", async (t) => {
    moduleControl.codejar = "ok";
    const env = installBrowser(t);
    const mount = env.$("#blueprint-editor");
    const editor = initBlueprintEditor(
      { mount, textarea: null },
      { getConfig: () => env.config },
    );
    await waitFor(() => !mount.classList.contains("is-hidden"), "CodeJar");
    editor.setCode('{"x": 1}');
    assert.equal(mount.textContent, '{"x": 1}');
  });
});
