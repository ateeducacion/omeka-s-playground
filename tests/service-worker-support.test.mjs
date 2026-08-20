import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createServiceWorkerUnsupportedError,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
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
