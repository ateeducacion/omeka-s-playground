import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  phpResponseToResponse,
  wrapPhpInstance,
} from "../src/runtime/php-compat.js";
import { createFakeRawPhp } from "./helpers/fake-php.mjs";

const ROOT = "/www/omeka";

function setup(options = {}, onRun) {
  const raw = createFakeRawPhp({
    files: {
      [`${ROOT}/index.php`]: "<?php // front",
      [`${ROOT}/install.php`]: "<?php // install",
      [`${ROOT}/application/asset/css/style.css`]: "body{}",
      [`${ROOT}/files/blob`]: "bin",
    },
    onRun: onRun ?? (() => ({ body: "ok" })),
  });
  return { raw, php: wrapPhpInstance(raw, options) };
}

describe("wrapPhpInstance request()", () => {
  it("serves existing static files with a MIME type and skips PHP", async () => {
    const { raw, php } = setup();
    const css = await php.request(
      new Request("https://x.test/application/asset/css/style.css"),
    );
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await css.text(), "body{}");
    const blob = await php.request(new Request("https://x.test/files/blob"));
    assert.equal(blob.headers.get("content-type"), "application/octet-stream");
    assert.equal(raw.runs.length, 0);
  });

  it("routes clean URLs to the front controller with CGI variables under a subpath", async () => {
    const { raw, php } = setup({
      absoluteUrl: "https://host.test/omeka-s-playground/",
    });
    const response = await php.request(
      new Request("https://ignored.test/admin/item?page=2", {
        headers: { "x-custom": "1", host: "evil" },
      }),
    );
    assert.equal(await response.text(), "ok");
    const run = raw.runs[0];
    assert.equal(run.scriptPath, `${ROOT}/index.php`);
    assert.equal(run.method, "GET");
    assert.equal(run.relativeUri, "/admin/item?page=2");
    assert.equal(run.body, undefined);
    const server = run.$_SERVER;
    assert.equal(server.SCRIPT_NAME, "/omeka-s-playground/index.php");
    assert.equal(server.REQUEST_URI, "/omeka-s-playground/admin/item?page=2");
    assert.equal(server.QUERY_STRING, "page=2");
    assert.equal(server.SERVER_PORT, "443");
    assert.equal(server.HTTPS, "on");
    assert.equal(server.HTTP_HOST, "host.test");
    assert.equal(server.HTTP_X_CUSTOM, "1");
    assert.equal(server.HTTP_HOST === "evil", false);
    assert.equal(raw.FS.cwd(), ROOT);
  });

  it("runs an existing PHP script and splits PATH_INFO", async () => {
    const { raw, php } = setup();
    await php.request(new Request("http://x.test/install.php/step/2"));
    assert.equal(raw.runs[0].scriptPath, `${ROOT}/install.php`);
    assert.equal(raw.runs[0].$_SERVER.PATH_INFO, "/step/2");
    assert.equal(raw.runs[0].$_SERVER.SERVER_PORT, "8080");
    assert.equal(raw.runs[0].$_SERVER.HTTPS, "");
  });

  it("maps a trailing slash to index.php and missing scripts to the front controller", async () => {
    const { raw, php } = setup({ absoluteUrl: "http://plain.test" });
    await php.request(new Request("http://x.test/"));
    await php.request(new Request("http://x.test/missing.php"));
    assert.equal(raw.runs[0].scriptPath, `${ROOT}/index.php`);
    assert.equal(raw.runs[0].$_SERVER.SERVER_PORT, "80");
    assert.equal(raw.runs[1].scriptPath, `${ROOT}/index.php`);
  });

  it("forwards POST bodies with content type and length", async () => {
    const { raw, php } = setup();
    await php.request(
      new Request("http://x.test/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=2",
      }),
    );
    const run = raw.runs[0];
    assert.equal(run.method, "POST");
    assert.equal(new TextDecoder().decode(run.body), "a=1&b=2");
    assert.equal(
      run.$_SERVER.CONTENT_TYPE,
      "application/x-www-form-urlencoded",
    );
    assert.equal(run.$_SERVER.CONTENT_LENGTH, "7");
  });

  it("falls back to an empty body when the request body cannot be read", async () => {
    const { raw, php } = setup();
    const request = new Request("http://x.test/save", {
      method: "POST",
      body: "x",
    });
    await request.text(); // body already consumed → arrayBuffer() throws
    await php.request(request);
    assert.equal(raw.runs[0].body.byteLength, 0);
    assert.equal(raw.runs[0].headers["content-length"], "0");
  });

  it("accepts a PHPRequest-shaped descriptor and defaults the method", async () => {
    const { raw, php } = setup();
    await php.request({ url: "/admin" });
    await php.request({});
    assert.equal(raw.runs[0].method, "GET");
    assert.equal(raw.runs[1].relativeUri, "/");
  });

  it("stores Set-Cookie values, replays them and forgets expired ones", async () => {
    const replies = [
      { headers: { "Set-Cookie": ["sid=abc; Path=/", "theme=dark", "bad"] } },
      { headers: { "set-cookie": ["theme=; Path=/", "sid=x; Max-Age=0"] } },
      {},
    ];
    const { raw, php } = setup({}, () => replies.shift() ?? {});
    await php.request(new Request("http://x.test/a"));
    await php.request(
      new Request("http://x.test/b", { headers: { cookie: "own=1" } }),
    );
    assert.equal(
      raw.runs[1].$_SERVER.HTTP_COOKIE,
      "own=1; sid=abc; theme=dark",
    );
    assert.equal(raw.runs[1].headers.cookie, "own=1; sid=abc; theme=dark");
    await php.request(new Request("http://x.test/c"));
    assert.equal(raw.runs[2].$_SERVER.HTTP_COOKIE, undefined);

    php.setCookie("manual", "v");
    await php.request(new Request("http://x.test/d"));
    assert.equal(raw.runs[3].$_SERVER.HTTP_COOKIE, "manual=v");
    php.setCookie("manual", "");
    php.setCookie("other", null);
    await php.request(new Request("http://x.test/e"));
    assert.equal(raw.runs[4].$_SERVER.HTTP_COOKIE, undefined);
  });

  it("calls syncFs after each request and survives a module without chdir", async () => {
    const raw = createFakeRawPhp({ onRun: () => ({ body: "x" }) });
    const { __private__dont__use } = await import("@php-wasm/universal");
    raw[__private__dont__use] = Promise.reject(new Error("no module"));
    let synced = 0;
    const php = wrapPhpInstance(raw, {
      syncFs: async () => {
        synced += 1;
      },
    });
    const response = await php.request(new Request("http://x.test/admin"));
    assert.equal(await response.text(), "x");
    assert.equal(synced, 1);
  });
});

describe("wrapPhpInstance filesystem helpers", () => {
  it("serveStatic returns files and null for PHP or missing paths", async () => {
    const { php } = setup();
    const response = php.serveStatic("/application/asset/css/style.css");
    assert.equal(await response.text(), "body{}");
    assert.equal(php.serveStatic("/install.php"), null);
    assert.equal(php.serveStatic("/nope.js"), null);
  });

  it("analyzePath reports files, folders, missing paths and errors", async () => {
    const { raw, php } = setup();
    assert.deepEqual(await php.analyzePath(`${ROOT}/index.php`), {
      exists: true,
      object: { isFolder: false, mode: 0o100644 },
    });
    assert.equal((await php.analyzePath(ROOT)).object.isFolder, true);
    assert.deepEqual(await php.analyzePath("/nope"), { exists: false });
    raw.fileExists = () => {
      throw new Error("boom");
    };
    assert.deepEqual(await php.analyzePath("/x"), { exists: false });
  });

  it("mkdir/writeFile/readFile/run/binary/_php delegate to the raw instance", async () => {
    const { raw, php } = setup({}, (req) => ({ body: `ran:${req.code}` }));
    await php.mkdir("/tmp/a/b");
    await php.writeFile("/tmp/a/b/f.txt", "hello");
    assert.equal(
      new TextDecoder().decode(await php.readFile("/tmp/a/b/f.txt")),
      "hello",
    );
    const result = await php.run("<?php echo 1;");
    assert.equal(result.text, "ran:<?php echo 1;");
    assert.equal((await php.binary).FS, raw.FS);
    assert.equal(php._php, raw);
  });

  it("forwards event listeners", () => {
    const { raw, php } = setup();
    const handler = () => {};
    php.addEventListener("request.end", handler);
    assert.deepEqual(raw.listeners.get("request.end"), [handler]);
    php.removeEventListener("request.end", handler);
    assert.deepEqual(raw.listeners.get("request.end"), []);
  });
});

describe("phpResponseToResponse", () => {
  it("skips an invalid header instead of failing the response", (t) => {
    const warnings = [];
    t.mock.method(console, "warn", (msg) => warnings.push(msg));
    const response = phpResponseToResponse({
      httpStatusCode: 200,
      headers: { "bad header": ["x"], "x-ok": ["1", "2"] },
      bytes: new TextEncoder().encode("hi"),
    });
    assert.equal(response.headers.get("x-ok"), "1, 2");
    assert.match(warnings[0], /skipping invalid response header "bad header"/);
  });

  it("builds a response without headers", async () => {
    const response = phpResponseToResponse({
      httpStatusCode: 201,
      bytes: new TextEncoder().encode("made"),
    });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "made");
  });
});
