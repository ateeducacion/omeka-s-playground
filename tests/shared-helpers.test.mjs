import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildManifestUrl, fetchManifest } from "../src/runtime/manifest.js";
import { getDefaultRuntime } from "../src/shared/config.js";
import { parseGitHubArchiveUrl } from "../src/shared/github.js";
import {
  createPhpBridgeChannel,
  createShellChannel,
  createWorkerRequestId,
  formatErrorDetail,
} from "../src/shared/protocol.js";
import { stubFetch } from "./helpers/fake-php.mjs";

describe("parseGitHubArchiveUrl", () => {
  it("parses codeload refs and rejects an empty archive ref or unparsable input", () => {
    assert.deepEqual(
      parseGitHubArchiveUrl(
        "https://codeload.github.com/o/r/zip/refs/tags/v1.0",
      ),
      {
        owner: "o",
        repo: "r",
        refType: "tags",
        ref: "v1.0",
        sourceUrl: "https://codeload.github.com/o/r/zip/refs/tags/v1.0",
      },
    );
    assert.equal(
      parseGitHubArchiveUrl("https://github.com/o/r/archive/refs/heads/.zip"),
      null,
    );
    assert.equal(parseGitHubArchiveUrl("http://[bad", "not a base"), null);
    assert.equal(parseGitHubArchiveUrl(undefined), null);
  });
});

describe("protocol helpers", () => {
  it("builds channel names with an optional instance id", () => {
    assert.equal(createShellChannel("s"), "omeka-playground-shell:s");
    assert.equal(createShellChannel("s", "i"), "omeka-playground-shell:s:i");
    assert.equal(createPhpBridgeChannel("s"), "omeka-playground-php:s");
  });

  it("creates unique UUID request ids", () => {
    const id = createWorkerRequestId();
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notEqual(id, createWorkerRequestId());
  });

  it("formats missing, string, stackless, plain and circular errors", () => {
    assert.equal(formatErrorDetail(null), "Unknown error");
    assert.equal(formatErrorDetail("plain"), "plain");
    const stackless = new Error("boom");
    stackless.stack = undefined;
    assert.equal(formatErrorDetail(stackless), "Error: boom");
    assert.equal(formatErrorDetail({ code: 1 }), '{\n  "code": 1\n}');
    const circular = {};
    circular.self = circular;
    assert.equal(formatErrorDetail(circular), "[object Object]");
  });
});

describe("getDefaultRuntime", () => {
  it("prefers the runtime marked default, else the first", () => {
    const a = { id: "a" };
    const b = { id: "b", default: true };
    assert.equal(getDefaultRuntime({ runtimes: [a, b] }), b);
    assert.equal(getDefaultRuntime({ runtimes: [a] }), a);
  });
});

describe("runtime fetchManifest fallback", () => {
  it("reports both failures when the legacy fallback is also missing", async (t) => {
    stubFetch(t, async () => new Response("", { status: 404 }));
    await assert.rejects(
      fetchManifest({ omekaVersion: "4.1.1" }),
      /Unable to load Omeka manifest \(version=4.1.1\): 404/,
    );
    await assert.rejects(fetchManifest(), /\(version=default\)/);
  });

  it("uses the default version manifest when none is given", () => {
    assert.match(buildManifestUrl().href, /assets\/manifests\/4\.2\.1\.json$/);
  });
});
