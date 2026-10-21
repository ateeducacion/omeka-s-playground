// Runs sw.js against fake Service Worker globals: each scenario imports a
// fresh module instance, dispatches install/activate/message/fetch events and
// answers the PHP bridge the way the php-worker would.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { createPhpBridgeChannel } from "../src/shared/protocol.js";

const ORIGIN = "https://play.test";
const STATIC_CACHE = `omeka-static-${BUILD_VERSION}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeBroadcastChannel {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.sent = [];
    this.throwOnPost = null;
    FakeBroadcastChannel.instances.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  postMessage(data) {
    if (FakeBroadcastChannel.throwOnPost)
      throw FakeBroadcastChannel.throwOnPost;
    this.sent.push(data);
  }
  reply(data) {
    for (const listener of this.listeners) listener({ data });
  }
  static named(name) {
    return FakeBroadcastChannel.instances.find(
      (channel) => channel.name === name,
    );
  }
}

function createCaches() {
  const stores = new Map();
  return {
    stores,
    failOpen: false,
    async open(name) {
      if (this.failOpen) throw new Error("SecurityError");
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async (request) => store.get(request.url)?.clone(),
        put: async (request, response) => {
          store.set(request.url, response);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

let instance = 0;
let env;

async function loadSw({
  scope = `${ORIGIN}/`,
  config = null,
  clients = {},
} = {}) {
  const listeners = {};
  const timers = [];
  const fetchCalls = [];
  const network = [];
  env = {
    listeners,
    timers,
    fetchCalls,
    network,
    claimed: false,
    skipped: false,
    caches: createCaches(),
  };
  globalThis.self = {
    registration: { scope },
    location: { origin: ORIGIN },
    addEventListener: (type, listener) => {
      listeners[type] = listener;
    },
    skipWaiting: async () => {
      env.skipped = true;
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clients: {
      get: async (id) => clients[id] ?? null,
      claim: async () => {
        env.claimed = true;
      },
    },
  };
  globalThis.caches = env.caches;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchCalls.push({ url, init, input });
    if (url.endsWith("playground.config.json")) {
      return config
        ? Response.json(config)
        : new Response("missing", { status: 404 });
    }
    const handler = network.find((entry) => entry.match(url, init));
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler.respond(url, init, input);
  };
  instance += 1;
  await import(`../sw.js?instance=${instance}`);
  return env;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  FakeBroadcastChannel.instances = [];
  FakeBroadcastChannel.throwOnPost = null;
  globalThis.fetch = originalFetch;
  delete globalThis.self;
  delete globalThis.caches;
});

function request(path, { referrer, mode, ...init } = {}) {
  const req = new Request(new URL(path, ORIGIN), init);
  if (referrer !== undefined)
    Object.defineProperty(req, "referrer", { value: referrer });
  if (mode !== undefined) Object.defineProperty(req, "mode", { value: mode });
  return req;
}

function dispatchFetch(req, { clientId = "" } = {}) {
  const event = { request: req, clientId, response: null };
  event.respondWith = (promise) => {
    event.response = promise;
  };
  env.listeners.fetch(event);
  return event;
}

function onNetwork(match, respond) {
  env.network.push({
    match: typeof match === "string" ? (url) => url === match : match,
    respond,
  });
}

async function phpRoundTrip(req, reply, { scopeId = "s1", clientId } = {}) {
  const event = dispatchFetch(req, { clientId });
  const bridgeName = createPhpBridgeChannel(scopeId);
  for (
    let i = 0;
    i < 50 && !FakeBroadcastChannel.named(bridgeName)?.sent.length;
    i += 1
  ) {
    await flush();
  }
  const bridge = FakeBroadcastChannel.named(bridgeName);
  const message = bridge.sent.shift();
  if (reply) bridge.reply({ id: message.id, ...reply });
  return { message, response: await event.response, bridge, event };
}

test("install skips waiting and activate prunes stale static caches", async () => {
  await loadSw();
  let installWork;
  env.listeners.install({
    waitUntil: (promise) => {
      installWork = promise;
    },
  });
  await installWork;
  assert.equal(env.skipped, true);

  for (const name of ["omeka-static-old", STATIC_CACHE, "unrelated"]) {
    await env.caches.open(name);
  }
  let activateWork;
  env.listeners.activate({
    waitUntil: (promise) => {
      activateWork = promise;
    },
  });
  await activateWork;
  assert.deepEqual(
    [...env.caches.stores.keys()].sort(),
    [STATIC_CACHE, "unrelated"].sort(),
  );
  assert.equal(env.claimed, true);
});

test("cross-origin requests are left to the browser", async () => {
  await loadSw();
  const event = dispatchFetch(new Request("https://cdn.test/lib.js"));
  assert.equal(event.response, null);
});

test("runtime WASM assets are served cache-first", async () => {
  await loadSw();
  let downloads = 0;
  onNetwork(
    (url) => url.endsWith("/dist/php.wasm"),
    () => {
      downloads += 1;
      return new Response("wasm-bytes", { status: 200 });
    },
  );
  onNetwork(
    (url) => url.endsWith("/dist/intl.so"),
    () => new Response("part", { status: 206 }),
  );

  const first = await dispatchFetch(request("/dist/php.wasm")).response;
  assert.equal(await first.text(), "wasm-bytes");
  await flush();
  const second = await dispatchFetch(request("/dist/php.wasm")).response;
  assert.equal(await second.text(), "wasm-bytes");
  assert.equal(downloads, 1, "second load comes from the cache");

  const partial = await dispatchFetch(request("/dist/intl.so")).response;
  assert.equal(partial.status, 206);
  await flush();
  assert.equal(
    env.caches.stores.get(STATIC_CACHE).has(`${ORIGIN}/dist/intl.so`),
    false,
  );

  // Range requests and an unavailable Cache API go straight to the network.
  await dispatchFetch(
    request("/dist/php.wasm", { headers: { range: "bytes=0-1" } }),
  ).response;
  env.caches.failOpen = true;
  await dispatchFetch(request("/dist/php.wasm")).response;
  assert.equal(downloads, 3);
});

test("the internal addon proxy needs a proxy URL and only the remote host may set one", async () => {
  await loadSw();
  const missing = await dispatchFetch(request("/__playground_proxy__?url=x"))
    .response;
  assert.equal(missing.status, 502);
  assert.match(await missing.text(), /No addon proxy configured\./u);

  // Omeka pages share the origin but must not reroute downloads.
  env.listeners.message({
    data: {
      kind: "configure-service-worker",
      addonProxyUrl: "https://evil.test/",
    },
    source: { url: `${ORIGIN}/playground/s1/r1/admin` },
  });
  env.listeners.message({
    data: {
      kind: "configure-service-worker",
      addonProxyUrl: "https://evil.test/",
    },
    source: { url: "not a url" },
  });
  env.listeners.message({ data: { kind: "other" } });
  const stillMissing = await dispatchFetch(request("/__playground_proxy__"))
    .response;
  assert.equal(stillMissing.status, 502);

  env.listeners.message({
    data: {
      kind: "configure-service-worker",
      addonProxyUrl: "https://proxy.test/zip",
    },
    source: { url: `${ORIGIN}/remote.html?scope=s1` },
  });
  onNetwork(
    (url) => url.startsWith("https://proxy.test/"),
    (_url, init) =>
      new Response(
        `proxied ${init.method} ${init.body ? new TextDecoder().decode(init.body) : ""}`,
        {
          status: 201,
          statusText: "Created",
          headers: { "content-length": "99", "x-upstream": "1" },
        },
      ),
  );
  const response = await dispatchFetch(
    request("/__playground_proxy__?url=https%3A%2F%2Fgithub.com%2Fa.zip", {
      method: "POST",
      body: "payload",
      headers: { "x-test": "yes" },
    }),
  ).response;
  const call = env.fetchCalls.at(-1);
  assert.equal(
    call.url,
    "https://proxy.test/zip?url=https%3A%2F%2Fgithub.com%2Fa.zip",
  );
  assert.equal(call.init.headers.get("x-test"), "yes");
  assert.equal(call.init.redirect, "follow");
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-upstream"), "1");
  assert.equal(await response.text(), "proxied POST payload");

  // Clearing the override falls back to the (absent) configured proxy.
  env.listeners.message({
    data: { kind: "configure-service-worker" },
    source: { url: `${ORIGIN}/remote.html` },
  });
  assert.equal(
    (await dispatchFetch(request("/__playground_proxy__")).response).status,
    502,
  );
});

test("the configured addon proxy is used and GET requests carry no body", async () => {
  await loadSw({ config: { addonProxyUrl: "https://cfg-proxy.test/" } });
  onNetwork(
    (url) => url.startsWith("https://cfg-proxy.test/"),
    () => new Response("ok"),
  );
  await dispatchFetch(request("/__playground_proxy__?url=a")).response;
  await dispatchFetch(request("/__playground_proxy__?url=b")).response;
  const proxied = env.fetchCalls.filter((call) =>
    call.url.startsWith("https://cfg-proxy.test/"),
  );
  assert.deepEqual(
    proxied.map((call) => call.url),
    ["https://cfg-proxy.test/?url=a", "https://cfg-proxy.test/?url=b"],
  );
  assert.equal(proxied[0].init.body, undefined);
  const configLoads = env.fetchCalls.filter((call) =>
    call.url.endsWith("playground.config.json"),
  );
  assert.equal(configLoads.length, 1, "config is fetched once");
  assert.equal(configLoads[0].init.cache, "no-store");
});

test("shell pages pass through and retry with a fresh fetch when aborted", async () => {
  await loadSw();
  let attempts = 0;
  onNetwork(`${ORIGIN}/?blueprint=x`, (_url, init) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("Failed to fetch");
    return new Response(`shell ${init.cache} ${init.credentials}`);
  });
  const response = await dispatchFetch(
    request("/?blueprint=x", { credentials: "omit" }),
  ).response;
  assert.equal(await response.text(), "shell reload omit");

  onNetwork(`${ORIGIN}/remote.html`, () => new Response("remote"));
  assert.equal(
    await (await dispatchFetch(request("/remote.html")).response).text(),
    "remote",
  );
  onNetwork(`${ORIGIN}/index.html`, (_url, init) => {
    if (!init) throw new TypeError("aborted");
    return new Response(init.credentials);
  });
  assert.equal(
    await (await dispatchFetch(request("/index.html")).response).text(),
    "same-origin",
  );
});

test("unscoped requests get the jQuery alias, a stub font CSS or the network", async () => {
  await loadSw();
  onNetwork(
    `${ORIGIN}/application/asset/vendor/jquery/jquery.min.js`,
    () => new Response("jq"),
  );
  onNetwork(`${ORIGIN}/assets/app.css`, () => new Response("css"));
  onNetwork(`${ORIGIN}/css`, () => new Response("real css"));

  assert.equal(
    await (
      await dispatchFetch(request("/jquery-3.7.1.min.js")).response
    ).text(),
    "jq",
  );
  const fonts = await dispatchFetch(request("/css?family=Roboto")).response;
  assert.equal(fonts.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(fonts.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(await fonts.text(), "");
  assert.equal(
    await (await dispatchFetch(request("/css")).response).text(),
    "real css",
  );
  // Host-static paths never resolve to a scope, even with a scoped referrer.
  const asset = dispatchFetch(
    request("/assets/app.css", {
      referrer: `${ORIGIN}/playground/s1/r1/admin`,
    }),
  );
  assert.equal(await (await asset.response).text(), "css");
});

test("scoped requests are forwarded to the PHP worker and responses rewritten", async () => {
  await loadSw();
  const { message, response } = await phpRoundTrip(
    request("/playground/s1/r1/admin/item?page=2", {
      method: "POST",
      body: "title=Hi",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
    {
      kind: "http-response",
      response: {
        body: '<a href="/admin/item/1">item</a>',
        status: 302,
        statusText: "Found",
        headers: {
          location: "/admin/login?redirect=1#f",
          "content-type": "text/html; charset=utf-8",
          "content-length": "32",
        },
      },
    },
    { clientId: "c1" },
  );
  assert.equal(message.kind, "http-request");
  assert.equal(message.request.url, `${ORIGIN}/admin/item?page=2`);
  assert.equal(message.request.method, "POST");
  assert.equal(
    message.request.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(new TextDecoder().decode(message.request.body), "title=Hi");
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "/playground/s1/r1/admin/login?redirect=1#f",
  );
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(
    await response.text(),
    '<a href="/playground/s1/r1/admin/item/1">item</a>',
  );
  assert.equal(env.timers[0].delay, 180000);

  // The remembered client context scopes its next unscoped request.
  const followUp = await phpRoundTrip(
    request("/files/original/a.png"),
    {
      kind: "http-response",
      response: {
        body: "png",
        status: 200,
        headers: {
          "content-type": "image/png",
          location: "https://other.test/x",
        },
      },
    },
    { clientId: "c1" },
  );
  assert.equal(followUp.message.request.url, `${ORIGIN}/files/original/a.png`);
  assert.equal(followUp.message.request.body, null);
  assert.equal(
    followUp.response.headers.get("location"),
    "https://other.test/x",
  );
  assert.equal(await followUp.response.text(), "png");
});

test("PHP worker errors, unknown replies and timeouts become error pages", async () => {
  await loadSw();
  const failed = await phpRoundTrip(request("/playground/s1/r1/"), {
    kind: "http-error",
    error: "<fatal>",
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failed.response.headers.get("cache-control"), "no-store");
  assert.match(await failed.response.text(), /<pre>&lt;fatal&gt;<\/pre>/u);

  const generic = await phpRoundTrip(request("/playground/s1/r1/"), {
    kind: "http-error",
  });
  assert.match(await generic.response.text(), /Unknown PHP worker error\./u);

  // Replies for unknown ids (or without one) are ignored; the timer settles it.
  const event = dispatchFetch(request("/playground/s1/r1/slow"));
  await flush();
  await flush();
  const bridge = FakeBroadcastChannel.named(createPhpBridgeChannel("s1"));
  bridge.reply({
    id: "nope",
    kind: "http-response",
    response: { body: "x", status: 200 },
  });
  bridge.reply({});
  env.timers.at(-1).callback();
  const timedOut = await event.response;
  assert.equal(timedOut.status, 504);
  assert.match(await timedOut.text(), /PHP worker bridge timed out\./u);

  FakeBroadcastChannel.throwOnPost = new Error("DataCloneError");
  const unclonable = await dispatchFetch(request("/playground/s1/r1/x"))
    .response;
  assert.equal(unclonable.status, 500);
  assert.match(await unclonable.text(), /DataCloneError/u);
});

test("unscoped navigations from a scoped page redirect into the scope", async () => {
  await loadSw({
    clients: {
      scoped: { url: `${ORIGIN}/playground/s9/r9/admin` },
      plain: { url: `${ORIGIN}/somewhere` },
      foreign: { url: "https://other.test/playground/s9/r9/" },
    },
  });
  const redirect = await dispatchFetch(
    request("/admin/items?sort=1", {
      referrer: `${ORIGIN}/playground/s2/r2/admin`,
      mode: "navigate",
    }),
  ).response;
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("location"),
    `${ORIGIN}/playground/s2/r2/admin/items?sort=1`,
  );

  // A non-navigation subresource is forwarded with the referrer's scope.
  const { message } = await phpRoundTrip(
    request("/api/items", { referrer: `${ORIGIN}/playground/s2/r2/admin` }),
    {
      kind: "http-response",
      response: { body: "[]", status: 200, headers: {} },
    },
    { scopeId: "s2" },
  );
  assert.equal(message.request.url, `${ORIGIN}/api/items`);

  // Without a referrer the controlling client's URL decides the scope.
  const fromClient = await phpRoundTrip(
    request("/api/sites", { referrer: "" }),
    {
      kind: "http-response",
      response: { body: "{}", status: 200, headers: {} },
    },
    { scopeId: "s9", clientId: "scoped" },
  );
  assert.equal(fromClient.message.request.url, `${ORIGIN}/api/sites`);

  onNetwork(`${ORIGIN}/api/free`, () => new Response("network"));
  for (const clientId of ["plain", "foreign", "missing"]) {
    const passed = await dispatchFetch(
      request("/api/free", { referrer: `${ORIGIN}/not-scoped` }),
      { clientId },
    ).response;
    assert.equal(await passed.text(), "network", clientId);
  }
});

test("an app served under a subpath keeps its base path", async () => {
  await loadSw({ scope: `${ORIGIN}/omeka/` });
  onNetwork(
    `${ORIGIN}/omeka/application/asset/vendor/jquery/jquery.min.js`,
    () => new Response("jq"),
  );
  onNetwork(`${ORIGIN}/omeka/`, () => new Response("shell"));
  onNetwork(`${ORIGIN}/other/page`, () => new Response("outside"));
  assert.equal(
    await (
      await dispatchFetch(request("/omeka/jquery-3.7.1.min.js")).response
    ).text(),
    "jq",
  );
  assert.equal(
    await (await dispatchFetch(request("/omeka/")).response).text(),
    "shell",
  );
  assert.equal(
    await (await dispatchFetch(request("/other/page")).response).text(),
    "outside",
  );

  const redirect = await dispatchFetch(
    request("/omeka/admin", {
      referrer: `${ORIGIN}/omeka/playground/s1/r1/`,
      mode: "navigate",
    }),
  ).response;
  assert.equal(
    redirect.headers.get("location"),
    `${ORIGIN}/omeka/playground/s1/r1/admin`,
  );

  const { message, response } = await phpRoundTrip(
    request("/omeka/playground/s1/r1"),
    {
      kind: "http-response",
      response: {
        body: "",
        status: 302,
        headers: { location: `${ORIGIN}/omeka/admin` },
      },
    },
  );
  assert.equal(message.request.url, `${ORIGIN}/`);
  assert.equal(
    response.headers.get("location"),
    "/omeka/playground/s1/r1/admin",
  );
});

test("a scope URL without a trailing slash is treated as the base path", async () => {
  await loadSw({ scope: `${ORIGIN}/app` });
  onNetwork(`${ORIGIN}/app`, () => new Response("shell"));
  assert.equal(
    await (await dispatchFetch(request("/app")).response).text(),
    "shell",
  );
});
