// Browser stand-ins for the shell entry points (src/shell/*.js): a happy-dom
// document built from the real index.html markup, plus fakes for the browser
// boundaries the shell talks to — location (navigations are recorded, not
// performed), the Service Worker container, BroadcastChannel, the clipboard,
// the remote iframe's postMessage, and fetch (served from the repository).
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";

const ROOT = new URL("../../", import.meta.url);
export const APP_ORIGIN = "https://play.test";
export const APP_BASE = `${APP_ORIGIN}/app/`;
export const TEST_DSN = "https://key@o1.ingest.example.test/42";
export const SENTRY_ENVELOPE_URL =
  "https://o1.ingest.example.test/api/42/envelope/";

// Parse the real index.html and drop its <script> elements: the tests import
// the shell modules themselves.
const indexDocument = new new Window().DOMParser().parseFromString(
  readFileSync(new URL("index.html", ROOT), "utf8"),
  "text/html",
);
for (const script of indexDocument.querySelectorAll("script")) script.remove();
const INDEX_BODY = indexDocument.body.innerHTML;

// The shell loads two modules by URL: the Ajv schema bundle from dist/ (built
// by `npm run build-worker`) and CodeJar from the jsDelivr CDN. Tests map the
// bundle to its source module and CodeJar to a tiny contenteditable fake, or
// make either import fail like an absent bundle / unreachable CDN.
export const moduleControl = { schema: "ok", codejar: "ok" };
const FAKE_CODEJAR = `export function CodeJar(el, highlight, options) {
  const listeners = [];
  globalThis.__codeJarInstances?.push({ el, options });
  el.addEventListener("input", () => {
    highlight(el);
    for (const cb of listeners) cb(el.textContent);
  });
  return {
    updateCode(code) { el.textContent = code; highlight(el); },
    toString() { return el.textContent; },
    onUpdate(cb) { listeners.push(cb); },
  };
}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes("/dist/blueprint-schema.bundle.js")) {
      if (moduleControl.schema !== "ok") {
        throw new Error("blueprint schema bundle not built");
      }
      return {
        url: new URL("src/shared/blueprint-schema.js", ROOT).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("https://cdn.jsdelivr.net/npm/codejar@")) {
      if (moduleControl.codejar !== "ok") {
        throw new Error("CDN unreachable");
      }
      return {
        url: `data:text/javascript,${encodeURIComponent(FAKE_CODEJAR)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

function createLocation(href) {
  let current = new URL(href);
  return {
    assigned: [],
    reloads: 0,
    get href() {
      return current.href;
    },
    set href(value) {
      this.assigned.push(String(value));
    },
    get origin() {
      return current.origin;
    },
    get pathname() {
      return current.pathname;
    },
    get hostname() {
      return current.hostname;
    },
    get search() {
      return current.search;
    },
    reload() {
      this.reloads += 1;
    },
    replace(value) {
      current = new URL(String(value), current);
    },
  };
}

class FakeBroadcastChannel {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.closed = false;
    FakeBroadcastChannel.instances.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  postMessage() {}
  close() {
    this.closed = true;
  }
  emit(data) {
    for (const listener of this.listeners) listener({ data });
  }
}

function setGlobal(name, value, restorers) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  restorers.push(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

/**
 * Install a browser-like global environment. Options:
 * - url: the shell URL (default APP_BASE + "index.html")
 * - session: initial sessionStorage entries
 * - serviceWorker: false (API missing), or overrides for the container fake
 * - config: overrides merged into playground.config.json
 * - fetchHandler(url, init): return a Response to override the repo-backed fetch
 * - markup: false to skip index.html (an empty body)
 */
export function installBrowser(t, options = {}) {
  const restorers = [];
  const happy = new Window({
    url: options.url || `${APP_BASE}index.html`,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const { document } = happy;
  if (options.markup !== false) {
    document.body.innerHTML = INDEX_BODY;
  }
  for (const [key, value] of Object.entries(options.session || {})) {
    happy.sessionStorage.setItem(key, value);
  }

  const location = createLocation(options.url || `${APP_BASE}index.html`);
  const history = {
    state: null,
    replaced: [],
    replaceState(_state, _title, url) {
      this.replaced.push(String(url));
      location.replace(url);
    },
  };
  const window = {
    location,
    history,
    sessionStorage: happy.sessionStorage,
  };

  const clipboard = {
    writes: [],
    fail: false,
    async writeText(text) {
      if (this.fail) throw new Error("denied");
      this.writes.push(text);
    },
  };

  const swListeners = [];
  const registrations = [];
  const serviceWorker =
    options.serviceWorker === false
      ? undefined
      : {
          controller: {},
          ready: Promise.resolve(),
          async register(url, opts) {
            registrations.push({ url: String(url), opts });
            if (this.registerError) throw this.registerError;
            return { update: async () => {} };
          },
          addEventListener(type, listener) {
            if (type === "message") swListeners.push(listener);
          },
          ...(options.serviceWorker || {}),
        };
  const navigator = serviceWorker
    ? { serviceWorker, clipboard }
    : { clipboard };

  const remotePosts = [];
  const remoteWindow = {
    postMessage(message, origin) {
      remotePosts.push({ message, origin });
    },
  };
  const frame = document.querySelector("#site-frame");
  if (frame) {
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => (env.remoteAvailable ? remoteWindow : null),
    });
  }

  const downloads = [];
  happy.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.href, download: this.download });
  };

  const config = {
    ...JSON.parse(
      readFileSync(new URL("playground.config.json", ROOT), "utf8"),
    ),
    sentry: { dsn: TEST_DSN },
    ...(options.config || {}),
  };
  const fetches = [];
  const reports = [];
  async function fetchImpl(input, init) {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    fetches.push({ url, init });
    if (url.startsWith(SENTRY_ENVELOPE_URL)) {
      const [, , event] = String(init.body).trim().split("\n");
      reports.push(JSON.parse(event));
      return new Response("{}");
    }
    const override = await options.fetchHandler?.(url, init);
    if (override) return override;
    if (url.endsWith("/playground.config.json")) {
      return Response.json(config);
    }
    if (url.startsWith(APP_BASE)) {
      const path = new URL(url).pathname.slice(
        new URL(APP_BASE).pathname.length,
      );
      try {
        return new Response(readFileSync(new URL(path, ROOT)));
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    return new Response("unexpected", { status: 500 });
  }

  FakeBroadcastChannel.instances = [];
  setGlobal("window", window, restorers);
  setGlobal("document", document, restorers);
  setGlobal("navigator", navigator, restorers);
  setGlobal("location", location, restorers);
  setGlobal("fetch", fetchImpl, restorers);
  setGlobal("BroadcastChannel", FakeBroadcastChannel, restorers);
  globalThis.__codeJarInstances = [];

  const env = {
    happy,
    document,
    window,
    location,
    history,
    navigator,
    serviceWorker,
    clipboard,
    registrations,
    remotePosts,
    remoteAvailable: true,
    downloads,
    fetches,
    reports,
    config,
    $: (selector) => document.querySelector(selector),
    channels: FakeBroadcastChannel.instances,
    /** The channel the shell is currently listening on. */
    channel() {
      return FakeBroadcastChannel.instances.at(-1);
    },
    emitServiceWorkerMessage(data) {
      for (const listener of swListeners) listener({ data });
    },
    logText() {
      return document.querySelector("#log-panel")?.textContent || "";
    },
  };

  t.after(async () => {
    for (const restore of restorers.reverse()) restore();
    moduleControl.schema = "ok";
    moduleControl.codejar = "ok";
    await happy.happyDOM.close();
  });
  return env;
}

/** Poll (macrotask by macrotask) until `predicate` holds; fail after ~2s. */
export async function waitFor(predicate, message = "condition") {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
