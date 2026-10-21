import assert from "node:assert/strict";
import { it } from "node:test";

// Separate process from the runtime tests: php-worker.js installs its listener
// at import time, so the failure path needs its own fresh module instance.
it("reports a startup error when the message listener cannot be installed", async () => {
  const originalSelf = globalThis.self;
  const messages = [];
  globalThis.self = {
    location: new URL(
      "https://app.test/php-worker.js?scope=s1&runtime=php83-omeka421",
    ),
    postMessage: (message) => messages.push(message),
    addEventListener() {
      throw new Error("no listeners");
    },
  };
  try {
    await assert.rejects(import("../php-worker.js"), /no listeners/);
  } finally {
    globalThis.self = originalSelf;
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "worker-startup-error");
  assert.equal(messages[0].scopeId, "s1");
  assert.equal(messages[0].runtimeId, "php83-omeka421");
  assert.match(messages[0].detail, /no listeners/);
});
