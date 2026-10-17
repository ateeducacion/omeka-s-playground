import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createServiceWorkerUnsupportedError,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
  registerClassicServiceWorker,
  SERVICE_WORKER_SCRIPT,
  SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
  SERVICE_WORKER_UNSUPPORTED_MESSAGE,
} from "../src/shared/service-worker-support.js";

describe("isServiceWorkerSupported", () => {
  it("accepts a navigator exposing a registerable container", () => {
    assert.equal(
      isServiceWorkerSupported({ serviceWorker: { register() {} } }),
      true,
    );
  });

  it("rejects a navigator without the API (iOS Safari private browsing)", () => {
    assert.equal(isServiceWorkerSupported({}), false);
  });

  it("rejects a present-but-unusable container", () => {
    // Insecure contexts can expose the property with nothing behind it.
    assert.equal(isServiceWorkerSupported({ serviceWorker: undefined }), false);
    assert.equal(isServiceWorkerSupported({ serviceWorker: null }), false);
    assert.equal(isServiceWorkerSupported({ serviceWorker: {} }), false);
    assert.equal(
      isServiceWorkerSupported({ serviceWorker: { register: "nope" } }),
      false,
    );
  });

  it("rejects a missing navigator without throwing", () => {
    assert.equal(isServiceWorkerSupported(undefined), false);
    assert.equal(isServiceWorkerSupported(null), false);
  });
});

describe("createServiceWorkerUnsupportedError", () => {
  it("carries a stable name and a human-readable message", () => {
    const error = createServiceWorkerUnsupportedError();
    assert.ok(error instanceof Error);
    assert.equal(error.name, SERVICE_WORKER_UNSUPPORTED_ERROR_NAME);
    assert.equal(error.name, "ServiceWorkerUnsupportedError");
    assert.equal(error.message, SERVICE_WORKER_UNSUPPORTED_MESSAGE);
    assert.match(error.message, /Private browsing on iOS Safari/u);
  });
});

describe("isServiceWorkerUnsupportedError", () => {
  it("distinguishes the unsupported error from a rejected registration", () => {
    assert.equal(
      isServiceWorkerUnsupportedError(createServiceWorkerUnsupportedError()),
      true,
    );
    assert.equal(isServiceWorkerUnsupportedError(new Error("Rejected")), false);
    assert.equal(isServiceWorkerUnsupportedError(undefined), false);
    assert.equal(isServiceWorkerUnsupportedError("Rejected"), false);
  });
});

describe("registerClassicServiceWorker", () => {
  const swUrl = new URL(`https://example.test/${SERVICE_WORKER_SCRIPT}`);

  function fakeNavigator(registration) {
    const calls = [];
    return {
      calls,
      serviceWorker: {
        register(url, options) {
          calls.push({ url, options });
          return Promise.resolve(registration);
        },
      },
    };
  }

  // Firefox < 147 (ESR 128/140) cannot run module Service
  // Workers, so sw.js "threw an exception during script evaluation".
  it("registers the classic sw.bundle.js, not a module worker", async () => {
    const nav = fakeNavigator({ update: async () => {} });
    await registerClassicServiceWorker(swUrl, nav);
    assert.equal(SERVICE_WORKER_SCRIPT, "sw.bundle.js");
    assert.equal(nav.calls.length, 1);
    assert.notEqual(nav.calls[0].options.type, "module");
    assert.equal(nav.calls[0].options.scope, "./");
  });

  // Sentry 145222608: update() failing (offline) or a registration without
  // update() must not abort the boot; the installed worker keeps serving.
  it("tolerates a failing update() and a missing registration", async () => {
    const failing = fakeNavigator({
      update: () => Promise.reject(new TypeError("Failed to update")),
    });
    await registerClassicServiceWorker(swUrl, failing);
    await registerClassicServiceWorker(swUrl, fakeNavigator(undefined));
  });

  it("throws the unsupported error without the API", async () => {
    await assert.rejects(registerClassicServiceWorker(swUrl, {}), (error) =>
      isServiceWorkerUnsupportedError(error),
    );
  });
});
