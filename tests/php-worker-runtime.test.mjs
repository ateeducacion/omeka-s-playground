import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, describe, it } from "node:test";
import { createFakeRawPhp } from "./helpers/fake-php.mjs";

// Drives php-worker.js through its real message protocol. The WASM runtime,
// Omeka bootstrap and CLI runtime are doubles (globalThis.__workerStub); the
// worker's own queueing, crash recovery and snapshot logic run for real.
const stubs = {
  "./src/runtime/bootstrap.js": `
    export const PLAYGROUND_DB_PATH = "/persist/mutable/db/omeka.sqlite";
    export const bootstrapOmeka = (o) => globalThis.__workerStub.bootstrapOmeka(o);
    export const startCoreArchivePrefetch = (o) => globalThis.__workerStub.startCoreArchivePrefetch(o);`,
  "./src/runtime/php-loader.js":
    "export const createPhpRuntime = (...a) => globalThis.__workerStub.createPhpRuntime(...a);",
  "./src/runtime/cli-runtime.js":
    "export const executeCliCommandInRuntime = (o) => globalThis.__workerStub.executeCli(o);",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ? new URL(context.parentURL).pathname : "";
    if (parent.endsWith("/php-worker.js") && stubs[specifier]) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const DB_PATH = "/persist/mutable/db/omeka.sqlite";
const shell = [];
const workerMessages = [];
const bridgeOut = [];
let bridge = null;
const closedChannels = [];
const originals = {};

class FakeBroadcastChannel extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    if (name.startsWith("omeka-playground-php:")) {
      bridge = this;
    }
  }
  postMessage(message) {
    if (this.name.startsWith("omeka-playground-php:")) {
      if (this.failNext) {
        this.failNext -= 1;
        throw new Error("bridge closed");
      }
      bridgeOut.push(message);
    } else {
      shell.push({ channel: this.name, ...message });
    }
  }
  close() {
    closedChannels.push(this.name);
  }
}

// Per-runtime behavior; tests mutate it between requests.
const behavior = {
  request: async () => new Response("page", { status: 200 }),
  serveStatic: () => null,
  bootstrap: async ({ publish }) => {
    publish("installing", 0.5);
    publish("still installing", 0.3);
    return { readyPath: "/admin/dashboard" };
  },
  dbBytes: "SQLite format 3",
};
const runtimes = [];

function createRuntime(runtime, options) {
  const raw = createFakeRawPhp();
  if (behavior.dbBytes) {
    raw.FS.mkdirTree("/persist/mutable/db");
    raw.writeFile(DB_PATH, behavior.dbBytes);
  }
  const php = {
    runtime,
    options,
    raw,
    refreshed: false,
    flushes: [],
    async refresh() {
      this.refreshed = true;
    },
    request: (request) => behavior.request(request, php),
    serveStatic: (pathname) => behavior.serveStatic(pathname, php),
    async flushPersistence(opts) {
      php.flushes.push(opts);
      if (behavior.flushError) throw behavior.flushError;
      return { enabled: false };
    },
    run: (code) => behavior.run(code),
    get _php() {
      return behavior.noRawPhp ? null : raw;
    },
  };
  runtimes.push(php);
  return php;
}

async function settle(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

let nextId = 0;
async function send(request, extra = {}) {
  const id = `req-${(nextId += 1)}`;
  bridge.dispatchEvent(
    new MessageEvent("message", {
      data: { kind: "http-request", id, request, ...extra },
    }),
  );
  const message = await settle(
    () => bridgeOut.find((entry) => entry.id === id),
    `response ${id}`,
  );
  const { response } = message;
  return { ...response, text: new TextDecoder().decode(response.body) };
}

const get = (path) => ({
  url: `https://app.test/playground/scope/rt${path}`,
  method: "GET",
  headers: {},
});

function postToWorker(data) {
  globalThis.self.dispatchEvent(new MessageEvent("message", { data }));
}

const fatal = () => new WebAssembly.RuntimeError("memory access out of bounds");

before(async () => {
  originals.self = globalThis.self;
  originals.BroadcastChannel = globalThis.BroadcastChannel;
  originals.fetch = globalThis.fetch;
  const worker = new EventTarget();
  worker.location = new URL(
    "https://app.test/dist/php-worker.bundle.js?scope=s1&runtime=php83-omeka421&instance=i1",
  );
  worker.postMessage = (message) => workerMessages.push(message);
  globalThis.self = worker;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /playground\.config\.json$/);
    return Response.json({
      phpCorsProxyUrl: "https://cors.test/?url=",
      landingPath: "/admin",
      opcache: true,
      runtimes: [
        {
          id: "php83-omeka421",
          label: "PHP 8.3 + Omeka S 4.2.1",
          phpVersion: "8.3",
          omekaVersion: "4.2.1",
          default: true,
        },
      ],
    });
  };
  globalThis.__workerStub = {
    createPhpRuntime: createRuntime,
    bootstrapOmeka: (options) => behavior.bootstrap(options),
    startCoreArchivePrefetch({ onProgress }) {
      onProgress({ ratio: 0.5 });
      onProgress({});
      return behavior.prefetchFails
        ? Promise.reject(new Error("prefetch failed"))
        : Promise.resolve({ manifest: {}, bytes: new Uint8Array() });
    },
    executeCli: async (options) => ({ stdout: "cli", options }),
  };
  await import("../php-worker.js");
});

after(() => {
  globalThis.self = originals.self;
  globalThis.BroadcastChannel = originals.BroadcastChannel;
  globalThis.fetch = originals.fetch;
});

describe("php-worker", () => {
  it("ignores unrelated messages and configures the bridge on request", () => {
    postToWorker({ kind: "something-else" });
    assert.equal(bridge, null);
    postToWorker({
      kind: "configure-blueprint",
      blueprint: { landingPage: "/s/demo" },
      runtimeParams: {
        scopeId: "s2",
        runtimeId: "php83-omeka421",
        instanceId: "i2",
      },
    });
    assert.equal(bridge.name, "omeka-playground-php:s2");
    assert.deepEqual(workerMessages.at(-1), {
      kind: "worker-ready",
      scopeId: "s2",
      runtimeId: "php83-omeka421",
    });
    // Reconfiguring without params keeps the scope and replaces the channel.
    postToWorker({ kind: "configure-blueprint", clean: true });
    assert.deepEqual(closedChannels, ["omeka-playground-php:s2"]);
    assert.equal(workerMessages.at(-1).scopeId, "s2");
  });

  it("ignores non-request bridge traffic", async () => {
    bridge.dispatchEvent(
      new MessageEvent("message", { data: { kind: "noise" } }),
    );
    bridge.dispatchEvent(new MessageEvent("message", { data: null }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridgeOut.length, 0);
  });

  it("does not cache a boot that failed before bootstrapOmeka()", async () => {
    const stub = globalThis.__workerStub;
    const createPhpRuntime = stub.createPhpRuntime;
    stub.createPhpRuntime = () => {
      stub.createPhpRuntime = createPhpRuntime;
      throw new Error("runtime download failed");
    };
    const bootstrap = behavior.bootstrap;
    behavior.bootstrap = async () => {
      throw new Error("second boot ran");
    };
    assert.match((await send(get("/admin"))).text, /runtime download failed/);
    assert.match((await send(get("/admin"))).text, /second boot ran/);
    behavior.bootstrap = bootstrap;
  });

  it("reports a bootstrap failure and boots again on the next request", async () => {
    behavior.bootstrap = async () => {
      throw new Error("install exploded");
    };
    behavior.prefetchFails = true;
    const failed = await send(get("/admin"));
    assert.equal(failed.status, 500);
    assert.match(failed.text, /install exploded/);
    assert.match(failed.headers["content-type"], /text\/html/);
    const error = shell.findLast((m) => m.kind === "error");
    assert.equal(error.path, "/playground/scope/rt/admin");
    assert.equal(error.channel, "omeka-playground-shell:s2:i2");
    behavior.prefetchFails = false;
    behavior.bootstrap = async ({ publish, clean, blueprint }) => {
      publish("installing", 0.5);
      publish("still installing", 0.3);
      publish("no progress");
      assert.equal(clean, true);
      assert.equal(blueprint, null); // the last configure carried none
      return { readyPath: "/admin/dashboard" };
    };
  });

  it("boots the runtime on first request and answers through PHP", async () => {
    shell.length = 0;
    const response = await send(get("/admin"));
    assert.equal(response.status, 200);
    assert.equal(response.text, "page");

    const php = runtimes.at(-1);
    assert.equal(php.refreshed, true);
    assert.equal(php.options.phpVersion, "8.3");
    assert.equal(php.options.phpCorsProxyUrl, "https://cors.test/?url=");
    assert.equal(php.options.scopeId, "s2");
    assert.equal(php.options.forceCleanBoot, true);
    assert.equal(php.options.opcache, true);
    assert.equal(php.options.appBaseUrl, "https://app.test/dist/");

    const progress = shell.filter((m) => m.kind === "progress");
    const values = progress.map((m) => m.progress);
    assert.deepEqual(
      values,
      [...values].sort((a, b) => a - b),
      "progress never goes backwards",
    );
    assert.ok(progress.some((m) => m.detail === "Downloading Omeka core: 50%"));
    assert.deepEqual(shell.at(-1), {
      channel: "omeka-playground-shell:s2:i2",
      kind: "ready",
      detail: "Omeka bootstrapped for PHP 8.3 + Omeka S 4.2.1.",
      path: "/admin/dashboard",
    });
  });

  it("does not rotate a runtime that crashes too early", async () => {
    // Fresh runtime counter: reconfigure keeps state, so check the guard first.
    // (Requests so far are < MIN_REQUESTS_BEFORE_RESTART on this runtime.)
    runtimes.at(-1).raw.unlink(DB_PATH);
    const before = runtimes.length;
    behavior.request = async () => {
      throw fatal();
    };
    const response = await send(get("/admin"));
    assert.equal(response.status, 500);
    assert.match(response.text, /<pre>Runtime crashed after only \d+ request/);
    assert.doesNotMatch(response.text, /restart limit/);
    // A declined POST must not claim the runtime is restarting either.
    const post = await send({ ...get("/admin"), method: "POST", body: "x" });
    assert.match(post.text, /<pre>Runtime crashed after only \d+ request/);
    assert.ok(
      shell.some((m) => /crash after only \d+ requests/.test(m.detail || "")),
    );
    assert.ok(
      shell.some(
        (m) =>
          m.detail === "[snapshot] live checkpoint skipped (db-read-failed)",
      ),
    );
    assert.equal(runtimes.length, before);
    behavior.request = async () => new Response("page");
  });

  it("forwards POST bodies and lets the spawn bridge reach the CLI runtime", async () => {
    let seen;
    behavior.request = async (request) => {
      seen = { method: request.method, body: await request.text() };
      return new Response("saved", { status: 201, statusText: "Created" });
    };
    const response = await send({
      url: "https://app.test/admin/item/add",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "title=1",
    });
    assert.deepEqual(seen, { method: "POST", body: "title=1" });
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Created");

    const php = runtimes.at(-1);
    const cli = await php.options.cliExecutor({ kind: "php" }, { cwd: "/x" });
    assert.equal(cli.stdout, "cli");
    assert.equal(cli.options.mainPhp, php);
    assert.deepEqual(cli.options.spawnOptions, { cwd: "/x" });
    assert.equal(cli.options.runtimeId, "php83-omeka421");
    behavior.request = async () => new Response("page");
  });

  it("serves static assets from MEMFS without entering the PHP queue", async () => {
    let phpCalls = 0;
    behavior.request = async () => {
      phpCalls += 1;
      return new Response("php");
    };
    behavior.serveStatic = (pathname) =>
      pathname.endsWith(".css") ? new Response("css") : null;
    assert.equal((await send(get("/a.css"))).text, "css");
    assert.equal(phpCalls, 0);

    // Not a static file → PHP pipeline; throwing serveStatic and non-GET too.
    assert.equal((await send(get("/admin"))).text, "php");
    behavior.serveStatic = () => {
      throw new Error("fs busy");
    };
    assert.equal((await send(get("/a.css"))).text, "php");
    assert.equal(
      (
        await send({
          url: "https://app.test/a.css",
          method: "POST",
          headers: {},
        })
      ).text,
      "php",
    );
    // An unparsable URL skips the fast path and fails as a request.
    assert.equal((await send({ url: "not a url", headers: {} })).status, 500);
    assert.equal(phpCalls, 3);

    // A body that fails to read falls back to a 500.
    behavior.serveStatic = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("broken stream"));
          },
        }),
      );
    const broken = await send(get("/b.css"));
    assert.equal(broken.status, 500);
    assert.match(broken.text, /Static fast-path failed/);
    behavior.serveStatic = () => null;
    behavior.request = async () => new Response("page");
  });

  it("answers ordinary PHP errors with a 500 without rotating the runtime", async () => {
    const before = runtimes.length;
    behavior.request = async () => {
      throw new Error("<b>bad</b> template");
    };
    const response = await send(get("/admin/items?x=1"));
    assert.equal(response.status, 500);
    assert.match(response.text, /&lt;b&gt;bad&lt;\/b&gt;/);
    assert.equal(runtimes.length, before);
    assert.equal(shell.at(-1).path, "/playground/scope/rt/admin/items");
    behavior.request = async () => new Response("page");
  });

  it("snapshots the DB, rotates and replays an idempotent request", async () => {
    for (let i = 0; i < 10; i += 1) await send(get("/warm"));
    const crashed = runtimes.at(-1);
    crashed.raw.FS.mkdirTree("/persist/mutable/db");
    crashed.raw.writeFile(DB_PATH, "SNAPSHOT-DB");
    behavior.dbBytes = "fresh-install-db";
    behavior.request = async (_request, php) => {
      if (php === crashed) throw fatal();
      return new Response("replayed");
    };
    const response = await send(get("/admin"));
    assert.equal(response.text, "replayed");
    const fresh = runtimes.at(-1);
    assert.notEqual(fresh, crashed);
    // The crashed runtime's DB was restored onto the fresh one before boot.
    assert.equal(fresh.raw.readFileAsText(DB_PATH), "SNAPSHOT-DB");
    assert.ok(
      shell.some(
        (m) => m.detail === "[snapshot] restored state onto fresh runtime",
      ),
    );
    assert.ok(
      shell.some((m) => /^\[runtime\] restart \(1\/20\)/.test(m.detail || "")),
    );
    assert.ok(shell.some((m) => m.title === "Crash recovery"));
  });

  it("gives up after a crash on retry", async () => {
    for (let i = 0; i < 10; i += 1) await send(get("/warm"));
    behavior.request = async () => {
      throw fatal();
    };
    const response = await send(get("/admin"));
    assert.equal(response.status, 503);
    assert.match(response.text, /crashed again on retry/);
    // Already marked as a retry: no second replay.
    for (let i = 0; i < 10; i += 1) {
      behavior.request = async () => new Response("ok");
      await send(get("/warm"));
    }
    behavior.request = async () => {
      throw fatal();
    };
    const retried = await send(get("/admin"), { _retried: true });
    assert.equal(retried.status, 503);
    assert.match(
      retried.text,
      /Runtime crashed again on retry. Manual reload required/,
    );
  });

  it("answers a retry that fails with a non-fatal error", async () => {
    behavior.request = async () => new Response("ok");
    for (let i = 0; i < 10; i += 1) await send(get("/warm"));
    const crashed = runtimes.at(-1);
    behavior.request = async (_request, php) => {
      if (php === crashed) throw fatal();
      throw new Error("plain failure");
    };
    const response = await send(get("/admin"));
    assert.equal(response.status, 503);
    assert.match(response.text, /plain failure/);
  });

  it("does not replay a crashed POST but boots the replacement runtime", async () => {
    behavior.request = async () => new Response("ok");
    // Each rotation needs fresh requests; the previous test rotated twice.
    for (let i = 0; i < 12; i += 1) await send(get("/warm"));
    const before = runtimes.length;
    behavior.request = async () => {
      throw fatal();
    };
    behavior.bootstrap = async () => {
      throw new Error("recovery boot failed");
    };
    const response = await send({
      url: "https://app.test/admin/item/add",
      method: "POST",
      headers: {},
      body: "x",
    });
    assert.equal(response.status, 503);
    assert.match(response.text, /Non-idempotent request was not retried/);
    await settle(
      () =>
        shell.find((m) =>
          /^Runtime recovery failed: .*recovery boot failed/s.test(
            m.detail || "",
          ),
        ),
      "recovery failure",
    );
    assert.equal(runtimes.length, before + 1);
    behavior.bootstrap = async () => ({});
    behavior.request = async () => new Response("ok");
    assert.equal((await send(get("/admin"))).text, "ok");
    assert.equal(shell.findLast((m) => m.kind === "ready").path, "/admin");
  });

  it("reports snapshot hydration failures and missing raw runtimes", async () => {
    for (let i = 0; i < 10; i += 1) await send(get("/warm"));
    const crashed = runtimes.at(-1);
    crashed.flushPersistence = async () => {
      throw null;
    };
    behavior.request = async (_request, php) => {
      if (php === crashed) throw fatal();
      return new Response("ok");
    };
    await send(get("/admin"));
    assert.ok(
      shell.some((m) =>
        /^\[runtime\] snapshot hydration failed: /.test(m.detail || ""),
      ),
    );

    behavior.request = async () => new Response("ok");
    for (let i = 0; i < 10; i += 1) await send(get("/warm"));
    behavior.noRawPhp = true;
    const crashed2 = runtimes.at(-1);
    behavior.request = async (_request, php) => {
      if (php === crashed2) throw fatal();
      return new Response("fresh");
    };
    assert.equal((await send(get("/admin"))).text, "fresh");
    behavior.noRawPhp = false;
  });

  it("keeps the queue alive when responding itself fails", async () => {
    behavior.request = async () => new Response("ok");
    bridge.failNext = 2;
    bridge.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "http-request", id: "lost", request: get("/admin") },
      }),
    );
    await settle(
      () =>
        shell.find(
          (m) => m.detail === "[worker] request handler failed: bridge closed",
        ),
      "handler failure",
    );
    assert.equal((await send(get("/admin"))).text, "ok");
  });

  it("captures phpinfo and flushes persistence for the shell", async () => {
    behavior.run = async (code) => {
      assert.match(code, /phpinfo\(\)/);
      return { text: "<h1>PHP</h1>" };
    };
    postToWorker({ kind: "capture-phpinfo" });
    const info = await settle(
      () => shell.find((m) => m.kind === "phpinfo"),
      "phpinfo",
    );
    assert.equal(info.html, "<h1>PHP</h1>");

    behavior.run = async () => ({});
    postToWorker({ kind: "capture-phpinfo" });
    await settle(
      () => shell.filter((m) => m.kind === "phpinfo").length === 2,
      "empty phpinfo",
    );
    assert.equal(shell.filter((m) => m.kind === "phpinfo")[1].html, "");

    behavior.run = async () => {
      throw new Error("<oops>");
    };
    postToWorker({ kind: "capture-phpinfo" });
    const failed = await settle(
      () => shell.filter((m) => m.kind === "phpinfo")[2],
      "failed phpinfo",
    );
    assert.match(failed.detail, /^Failed to capture PHP info: Error: <oops>/);
    assert.match(failed.html, /&lt;oops&gt;/);

    postToWorker({ kind: "flush-persistence" });
    const flushed = await settle(
      () => shell.find((m) => m.kind === "persistence-flushed"),
      "flush",
    );
    assert.equal(flushed.detail, "Persistence journal flushed.");

    behavior.flushError = new Error("idb gone");
    postToWorker({ kind: "flush-persistence" });
    const flushFailed = await settle(
      () => shell.filter((m) => m.kind === "persistence-flushed")[1],
      "flush failure",
    );
    assert.match(
      flushFailed.detail,
      /^Persistence flush failed: Error: idb gone/,
    );
    behavior.flushError = null;
  });

  it("posts a trace when the request high watermark is reached", async () => {
    behavior.request = async () => new Response("ok");
    const before = shell.length;
    let found = null;
    for (let i = 0; i < 1600 && !found; i += 1) {
      await send(get("/warm"));
      found = shell
        .slice(before)
        .find((m) => /request count reached 1500/.test(m.detail || ""));
    }
    assert.ok(found);
  });

  it("stops rotating once the restart limit is reached", async () => {
    let limited = null;
    for (let round = 0; round < 25 && !limited; round += 1) {
      behavior.request = async () => new Response("ok");
      for (let i = 0; i < 10; i += 1) await send(get("/warm"));
      const crashed = runtimes.at(-1);
      behavior.request = async (_request, php) => {
        if (php === crashed) throw fatal();
        return new Response("ok");
      };
      const response = await send(get("/admin"));
      limited = shell.find((m) =>
        /restart limit reached \(20\/20\)/.test(m.detail || ""),
      );
      if (limited) {
        assert.match(response.text, /<pre>Runtime restart limit reached\./);
      }
    }
    assert.ok(limited);
  });
});
