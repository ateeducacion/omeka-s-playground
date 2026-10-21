import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEvent,
  captureException,
  captureMessage,
  createMonitoringClient,
  initMonitoring,
  parseStackFrames,
} from "../src/shared/monitoring.js";

const TEST_DSN = "https://abc123@o111.ingest.de.sentry.io/222";

function capturingFetch() {
  const bodies = [];
  return {
    bodies,
    events: () =>
      bodies.map((body) => JSON.parse(body.trimEnd().split("\n")[2])),
    fetchImpl: (_url, init) => {
      bodies.push(init.body);
      return Promise.resolve(new Response(""));
    },
  };
}

function withLocation(t, href) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    value: new URL(href),
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete globalThis.location;
  });
}

describe("buildEvent in a page context", () => {
  it("records the page URL and user agent, and detects development hosts", (t) => {
    for (const host of ["localhost", "127.0.0.1", "box.local"]) {
      withLocation(t, `http://${host}/app/`);
      const event = buildEvent({ message: "hi" });
      assert.equal(event.environment, "development", host);
      assert.equal(event.request.url, `http://${host}/app/`);
      assert.equal(
        event.request.headers["User-Agent"],
        globalThis.navigator.userAgent,
      );
    }
    withLocation(t, "https://erseco.github.io/omeka-s-playground/");
    assert.equal(buildEvent({ message: "hi" }).environment, "production");
  });

  it("generates a 32-hex event id without crypto.randomUUID", (t) => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    t.after(() => {
      delete globalThis.crypto.randomUUID;
    });
    assert.match(buildEvent({ message: "x" }).event_id, /^[0-9a-f]{32}$/);
  });

  it("defaults the exception type and uses the error itself as value", () => {
    const event = buildEvent({ error: { name: "", stack: "" } });
    assert.equal(event.exception.values[0].type, "Error");
    assert.equal(event.exception.values[0].value, "[object Object]");
    assert.equal(event.exception.values[0].stacktrace, undefined);
  });
});

describe("parseStackFrames", () => {
  it("keeps at most 50 frames", () => {
    const stack = Array.from(
      { length: 60 },
      (_, index) => `    at f${index} (https://x.test/a.js:${index + 1}:1)`,
    ).join("\n");
    const frames = parseStackFrames(stack);
    assert.equal(frames.length, 50);
    assert.equal(frames.at(-1).function, "f0");
  });
});

describe("client resilience", () => {
  it("swallows errors raised while building an event", () => {
    const { bodies, fetchImpl } = capturingFetch();
    const client = createMonitoringClient({ dsn: TEST_DSN, fetchImpl });
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter");
      },
    });
    assert.doesNotThrow(() => client.captureException(hostile));
    assert.doesNotThrow(() =>
      client.captureMessage({
        toString() {
          throw new Error("toString");
        },
      }),
    );
    assert.equal(bodies.length, 0);
  });

  it("tolerates a fetch implementation that returns nothing", () => {
    const client = createMonitoringClient({
      dsn: TEST_DSN,
      fetchImpl: () => undefined,
    });
    assert.doesNotThrow(() => client.captureMessage("sent"));
  });
});

describe("initMonitoring global handlers and module helpers", () => {
  it("reports message-only error events and reason-less rejections", () => {
    const { events, fetchImpl } = capturingFetch();
    const handlers = new Map();
    initMonitoring({
      dsn: TEST_DSN,
      fetchImpl,
      scope: {
        addEventListener: (name, handler) => handlers.set(name, handler),
      },
    });
    handlers.get("error")({ message: "Script error." });
    handlers.get("error")({});
    handlers.get("unhandledrejection")(undefined);

    const [message, rejection] = events();
    assert.equal(message.message.formatted, "Script error.");
    assert.equal(message.level, "error");
    assert.equal(message.extra.source, "window.onerror");
    assert.equal(rejection.exception.values[0].value, "Unhandled rejection");
    assert.equal(events().length, 2);
  });

  it("routes captureException/captureMessage to the active client", () => {
    const { events, fetchImpl } = capturingFetch();
    initMonitoring({ dsn: TEST_DSN, fetchImpl, scope: {} });
    captureException(new Error("boom"), { phase: "boot" });
    captureMessage("note", "warning");
    captureMessage("default level");
    const [exception, warning, info] = events();
    assert.equal(exception.exception.values[0].value, "boom");
    assert.deepEqual(exception.extra, { phase: "boot" });
    assert.equal(warning.level, "warning");
    assert.equal(info.level, "info");
  });
});
