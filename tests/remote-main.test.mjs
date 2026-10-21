// Boots src/remote/main.js (the runtime host page) under happy-dom with fake
// Service Worker, Web Locks, Worker and BroadcastChannel boundaries, then
// drives the boot handshake the way the browser and the PHP worker would.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { BUILD_VERSION } from "../src/generated/build-version.js";
import { createShellChannel } from "../src/shared/protocol.js";

const ORIGIN = "https://play.test";
const RUNTIME = "php83-omeka421";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeBroadcastChannel {
  static instances = [];
  static sent = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    FakeBroadcastChannel.instances.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  postMessage(data) {
    FakeBroadcastChannel.sent.push({ name: this.name, data });
  }
  close() {}
  static deliver(name, data) {
    for (const channel of FakeBroadcastChannel.instances) {
      if (channel.name === name) {
        for (const listener of channel.listeners) listener({ data });
      }
    }
  }
}

class FakeWorker {
  static instances = [];
  constructor(url, options) {
    this.url = new URL(url);
    this.options = options;
    this.listeners = { message: [], error: [] };
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  addEventListener(type, listener) {
    this.listeners[type].push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }
  postMessage(data) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  emit(type, event) {
    for (const listener of [...this.listeners[type]]) listener(event);
  }
}

function createLocks({ available = true } = {}) {
  const locks = { requested: [], released: 0 };
  locks.request = (name, options, callback) => {
    locks.requested.push({ name, options });
    return Promise.resolve(callback(available ? { name } : null)).then(() => {
      locks.released += 1;
    });
  };
  return locks;
}

function createServiceWorkerContainer({ controlled = false } = {}) {
  const listeners = {};
  const container = {
    controller: controlled
      ? {
          posted: [],
          postMessage(m) {
            this.posted.push(m);
          },
        }
      : null,
    registered: [],
    ready: Promise.resolve({ active: true }),
    async register(url, options) {
      container.registered.push({ url: new URL(url), options });
      return {
        update: async () => {
          throw new Error("offline");
        },
      };
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    takeControl() {
      container.controller = {
        posted: [],
        postMessage(m) {
          this.posted.push(m);
        },
      };
      listeners.controllerchange?.();
    },
  };
  return container;
}

let window;
let counter = 0;

async function bootRemote({ search, navigator, session = {} }) {
  window = new Window({
    url: `${ORIGIN}/remote.html${search}`,
    settings: { disableIframePageLoading: true },
  });
  window.document.body.innerHTML = `
    <iframe id="remote-frame"></iframe>
    <div class="remote-boot__card">
      <strong id="remote-title">Preparing</strong>
      <div class="progress-bar__fill" id="progress-fill"></div>
      <span id="progress-percent">0%</span>
      <span id="remote-status">Initializing</span>
    </div>`;
  for (const [key, value] of Object.entries(session)) {
    window.sessionStorage.setItem(key, value);
  }
  const frame = window.document.querySelector("#remote-frame");
  const frameLocation = { href: "about:blank", reloads: 0 };
  frameLocation.reload = () => {
    frameLocation.reloads += 1;
  };
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => ({ location: frameLocation }),
  });
  window.location.reload = () => {
    window.reloaded = true;
  };
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  globalThis.Worker = FakeWorker;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        addonProxyUrl: "https://proxy.test/",
        runtimes: [
          { id: RUNTIME, label: "PHP 8.3 + Omeka S 4.2.1", default: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  counter += 1;
  await import(`../src/remote/main.js?case=${counter}`);
  return { frame, frameLocation, doc: window.document };
}

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const originalFetch = globalThis.fetch;
afterEach(async () => {
  FakeBroadcastChannel.instances = [];
  FakeBroadcastChannel.sent = [];
  FakeWorker.instances = [];
  Object.defineProperty(globalThis, "navigator", originalNavigator);
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  delete globalThis.document;
  await window?.happyDOM.close();
});

function sentOn(scopeId) {
  return FakeBroadcastChannel.sent
    .filter((entry) => entry.name.startsWith(createShellChannel(scopeId)))
    .map((entry) => entry.data);
}

test("registers the SW, boots the PHP worker and loads the scoped frame", async () => {
  const serviceWorker = createServiceWorkerContainer();
  const locks = createLocks();
  const { frame, frameLocation, doc } = await bootRemote({
    search:
      "?scope=s1&runtime=php83-omeka421&path=/admin&instance=i1&opcache=0",
    navigator: { serviceWorker, locks },
    session: { "omeka-playground:blueprint:s1": JSON.stringify({ steps: [] }) },
  });

  await waitFor(() => serviceWorker.registered.length === 1, "SW register");
  const swUrl = serviceWorker.registered[0].url;
  assert.match(swUrl.pathname, /\/sw\.bundle\.js$/u);
  assert.equal(swUrl.searchParams.get("v"), BUILD_VERSION);
  assert.equal(swUrl.searchParams.get("scope"), "s1");
  assert.equal(swUrl.searchParams.get("runtime"), RUNTIME);
  assert.deepEqual(serviceWorker.registered[0].options, {
    scope: "./",
    updateViaCache: "none",
  });
  assert.equal(locks.requested[0].name, "omeka-playground-owner:s1");
  assert.equal(doc.querySelector("#progress-percent").textContent, "8%");
  assert.equal(sentOn("s1")[0].kind, "progress");

  await flush();
  assert.equal(FakeWorker.instances.length, 0, "waits for SW control first");
  serviceWorker.takeControl();
  await waitFor(() => FakeWorker.instances.length === 1, "worker spawn");
  assert.deepEqual(serviceWorker.controller.posted, [
    { kind: "configure-service-worker", addonProxyUrl: "https://proxy.test/" },
  ]);

  const worker = FakeWorker.instances[0];
  assert.match(worker.url.pathname, /\/dist\/php-worker\.bundle\.js$/u);
  assert.equal(worker.url.searchParams.get("instance"), "i1");
  assert.equal(worker.url.searchParams.get("opcache"), "0");
  assert.deepEqual(worker.options, { type: "module" });
  assert.equal(worker.posted[0].kind, "configure-blueprint");
  assert.deepEqual(worker.posted[0].runtimeParams, {
    scopeId: "s1",
    runtimeId: RUNTIME,
    instanceId: "i1",
    opcacheParam: "0",
  });
  assert.equal(worker.posted[0].clean, false);
  assert.deepEqual(worker.posted[0].blueprint, { steps: [] });

  // Bootstrap progress relayed on the shell channel updates the overlay.
  const shellName = createShellChannel("s1", "i1");
  FakeBroadcastChannel.deliver(shellName, {
    kind: "progress",
    detail: "Unpacking",
    progress: 2,
  });
  assert.equal(doc.querySelector("#remote-status").textContent, "Unpacking");
  assert.equal(doc.querySelector("#progress-fill").style.width, "100%");
  FakeBroadcastChannel.deliver(shellName, { kind: "error", detail: "warn" });
  assert.equal(doc.querySelector("#remote-status").textContent, "warn");

  // Worker errors are surfaced with their location.
  worker.emit("error", { message: "boom", filename: "w.js", lineno: 3 });
  assert.equal(
    doc.querySelector("#remote-status").textContent,
    "boom | file=w.js | line=3",
  );
  worker.emit("error", {});
  assert.equal(
    doc.querySelector("#remote-status").textContent,
    "php-worker failed before signalling readiness.",
  );

  // Readiness for another runtime or an unrelated message is ignored.
  worker.emit("message", { data: { kind: "noise" } });
  worker.emit("message", {
    data: { kind: "worker-ready", scopeId: "s1", runtimeId: "other" },
  });
  await flush();
  assert.equal(frame.src, "");
  worker.emit("message", {
    data: { kind: "worker-ready", scopeId: "s1", runtimeId: RUNTIME },
  });
  await waitFor(() => frame.src !== "", "frame navigation");
  assert.equal(frame.src, `${ORIGIN}/playground/s1/${RUNTIME}/admin`);
  assert.deepEqual(
    JSON.parse(window.sessionStorage.getItem("omeka-playground:s1:state")),
    { runtimeId: RUNTIME, path: "/admin" },
  );

  // The iframe load reports readiness and the unscoped path to the shell.
  frameLocation.href = `${ORIGIN}/playground/s1/${RUNTIME}/admin/items?page=2#top`;
  frame.dispatchEvent(new window.Event("load"));
  assert.ok(
    doc.querySelector(".remote-boot__card").classList.contains("is-hidden"),
  );
  const tail = sentOn("s1").slice(-2);
  assert.deepEqual(tail[0], {
    kind: "ready",
    detail: `Iframe loaded for ${RUNTIME}.`,
    path: "/admin/items?page=2#top",
  });
  assert.deepEqual(tail[1], {
    kind: "navigate",
    path: "/admin/items?page=2#top",
  });

  // A frame outside this scope keeps its full path.
  frameLocation.href = `${ORIGIN}/elsewhere/page`;
  frame.dispatchEvent(new window.Event("load"));
  assert.deepEqual(sentOn("s1").at(-1), {
    kind: "navigate",
    path: "/elsewhere/page",
  });

  // Shell commands: only same-origin messages are obeyed.
  const post = (data, origin = ORIGIN) =>
    window.dispatchEvent(new window.MessageEvent("message", { data, origin }));
  post({ kind: "navigate-site", path: "/s/site" }, "https://evil.test");
  assert.equal(frame.src, `${ORIGIN}/playground/s1/${RUNTIME}/admin`);
  post({ kind: "navigate-site", path: "/s/site" });
  assert.equal(frame.src, `${ORIGIN}/playground/s1/${RUNTIME}/s/site`);
  post({ kind: "navigate-site", path: "/s/site" });
  assert.equal(frameLocation.href, `${ORIGIN}/playground/s1/${RUNTIME}/s/site`);
  post({ kind: "navigate-site" });
  assert.equal(frame.src, `${ORIGIN}/playground/s1/${RUNTIME}/`);
  post({ kind: "refresh-site" });
  assert.equal(frameLocation.reloads, 1);
  post({ kind: "capture-phpinfo" });
  post({ kind: "flush-persistence" });
  post({ kind: "unknown" });
  assert.deepEqual(worker.posted.slice(1), [
    { kind: "capture-phpinfo" },
    { kind: "flush-persistence" },
  ]);

  // A "ready" with a new landing path navigates the frame there.
  FakeBroadcastChannel.deliver(shellName, {
    kind: "ready",
    detail: "Done",
    path: "/admin/login",
  });
  assert.equal(frame.src, `${ORIGIN}/playground/s1/${RUNTIME}/admin/login`);
  assert.equal(doc.querySelector("#progress-percent").textContent, "100%");

  // Leaving the page terminates the worker and releases the scope lock.
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(worker.terminated, true);
  await waitFor(() => locks.released === 1, "scope release");

  window.dispatchEvent(
    Object.assign(new window.Event("pageshow"), { persisted: false }),
  );
  assert.equal(window.reloaded, undefined);
  window.dispatchEvent(
    Object.assign(new window.Event("pageshow"), { persisted: true }),
  );
  assert.equal(window.reloaded, true);
});

test("an already-controlled tab reuses the SW and honours an early ready path", async () => {
  const serviceWorker = createServiceWorkerContainer({ controlled: true });
  const { frame } = await bootRemote({
    search: "?scope=s2&clean=1&instance=i2",
    navigator: { serviceWorker, locks: createLocks() },
  });
  await waitFor(() => FakeWorker.instances.length === 1, "worker spawn");
  assert.equal(serviceWorker.registered.length, 0);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.posted[0].clean, true);
  assert.equal(worker.posted[0].blueprint, null);
  assert.equal(worker.url.searchParams.has("opcache"), false);

  // The worker's ready message arrives before worker-ready: it wins.
  FakeBroadcastChannel.deliver(createShellChannel("s2", "i2"), {
    kind: "ready",
    detail: "Ready",
    path: "/s/demo",
  });
  assert.equal(frame.src, `${ORIGIN}/playground/s2/${RUNTIME}/s/demo`);
  worker.emit("message", {
    data: { kind: "worker-ready", scopeId: "s2", runtimeId: RUNTIME },
  });
  await waitFor(
    () => window.sessionStorage.getItem("omeka-playground:s2:state"),
    "state",
  );
  assert.equal(frame.src, `${ORIGIN}/playground/s2/${RUNTIME}/s/demo`);
});

async function expectBootError(options, expected) {
  await bootRemote(options);
  const scopeId = new URLSearchParams(options.search).get("scope");
  await waitFor(
    () => sentOn(scopeId).some((message) => message.kind === "error"),
    "boot error",
  );
  const error = sentOn(scopeId).find((message) => message.kind === "error");
  assert.equal(
    window.document.querySelector("#remote-title").textContent,
    "The playground cannot start",
  );
  assert.match(
    window.document.querySelector("#remote-status").textContent,
    expected.message,
  );
  assert.equal(error.errorName, expected.name);
  assert.match(error.detail, expected.message);
  assert.ok(
    !window.document
      .querySelector(".remote-boot__card")
      .classList.contains("is-hidden"),
  );
}

test("reports an unsupported browser when Service Workers are missing", async () => {
  await expectBootError(
    { search: "?scope=s3", navigator: { locks: createLocks() } },
    {
      name: "ServiceWorkerUnsupportedError",
      message: /Service Workers are unavailable/u,
    },
  );
});

test("reports a second tab trying to own the same scope", async () => {
  await expectBootError(
    {
      search: "?scope=s4",
      navigator: {
        serviceWorker: createServiceWorkerContainer(),
        locks: createLocks({ available: false }),
      },
    },
    { name: "Error", message: /already open in another tab/u },
  );
});

test("reports a PHP worker startup failure", async () => {
  await bootRemote({
    search: "?scope=s5",
    navigator: {
      serviceWorker: createServiceWorkerContainer({ controlled: true }),
      locks: createLocks(),
    },
  });
  await waitFor(() => FakeWorker.instances.length === 1, "worker spawn");
  FakeWorker.instances[0].emit("message", {
    data: { kind: "worker-startup-error", detail: "no wasm" },
  });
  await waitFor(() => sentOn("s5").some((m) => m.kind === "error"), "error");
  // The overlay keeps the message; the stack only travels to the shell logs.
  const status = window.document.querySelector("#remote-status");
  const sent = FakeBroadcastChannel.sent.find((m) => m.data.kind === "error");
  assert.match(sent.data.detail, /^no wasm\nError: no wasm\n {4}at /u);
  assert.equal(status.textContent, "no wasm");
  // A real BroadcastChannel also delivers the error to this page's own
  // shell-channel listener; that must not bring the stack back either.
  FakeBroadcastChannel.deliver(sent.name, sent.data);
  assert.equal(status.textContent, "no wasm");
  FakeWorker.instances.length = 0;
});

test("a startup error without detail gets a generic message", async () => {
  await bootRemote({
    search: "?scope=s6",
    navigator: {
      serviceWorker: createServiceWorkerContainer({ controlled: true }),
      locks: createLocks(),
    },
  });
  await waitFor(() => FakeWorker.instances.length === 1, "worker spawn");
  FakeWorker.instances[0].emit("message", {
    data: { kind: "worker-startup-error" },
  });
  await waitFor(() => sentOn("s6").some((m) => m.kind === "error"), "error");
  assert.match(
    window.document.querySelector("#remote-status").textContent,
    /^php-worker failed during startup\./u,
  );
});

test("leaving the page before the scope lock resolves skips the boot", async () => {
  let grant;
  const locks = {
    released: 0,
    request: (_name, _options, callback) =>
      new Promise((resolve) => {
        grant = () => resolve(callback({}));
      }).then(() => {
        locks.released += 1;
      }),
  };
  const serviceWorker = createServiceWorkerContainer();
  await bootRemote({
    search: "?scope=s7",
    navigator: { serviceWorker, locks },
  });
  window.dispatchEvent(new window.Event("pagehide"));
  grant();
  await waitFor(() => locks.released === 1, "release");
  await flush();
  assert.equal(serviceWorker.registered.length, 0);
  assert.equal(FakeWorker.instances.length, 0);
  assert.equal(sentOn("s7").length, 0);
});

test("leaving the page while waiting for SW control skips the PHP worker", async () => {
  const serviceWorker = createServiceWorkerContainer();
  await bootRemote({
    search: "?scope=s8",
    navigator: { serviceWorker, locks: createLocks() },
  });
  await waitFor(() => serviceWorker.registered.length === 1, "register");
  await flush();
  window.dispatchEvent(new window.Event("pagehide"));
  serviceWorker.takeControl();
  await flush();
  await flush();
  assert.equal(FakeWorker.instances.length, 0);
});
