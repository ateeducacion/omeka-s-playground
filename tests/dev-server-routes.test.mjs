import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addressIsBlocked,
  createDevServer,
  ProxyValidationError,
  requestWithCurlRedirects,
  requestWithNodeRedirects,
  requestWithValidatedRedirects,
  resolvePublicHost,
} from "../scripts/dev-server.mjs";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const toLocal = async () => [{ address: "127.0.0.1", family: 4 }];

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

// Upstream fixture: each path scripts one upstream behavior.
let upstream;
let upstreamPort;
before(async () => {
  upstream = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/redirect") {
      response.writeHead(302, { location: "/file.zip" });
      response.end();
    } else if (path === "/file.zip") {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="file.zip"',
        "set-cookie": ["a=1", "b=2"],
      });
      response.end("zip-bytes");
    } else if (path === "/plain") {
      response.end("plain-body");
    } else if (path === "/huge-declared") {
      response.writeHead(200, { "content-length": String(60_000_000) });
      response.write("x");
    } else if (path === "/huge-streamed") {
      response.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 120);
      let sent = 0;
      const pump = () => {
        while (sent < 60) {
          sent += 1;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      response.on("error", () => {});
      pump();
    } else if (path === "/missing") {
      response.writeHead(404);
      response.end("nope");
    } else if (path === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else {
      response.writeHead(500);
      response.end();
    }
  });
  upstreamPort = await listen(upstream);
});

after(() => close(upstream));

describe("requestWithNodeRedirects against a pinned upstream", () => {
  it("follows a validated redirect and returns the final body", async () => {
    const result = await requestWithNodeRedirects(
      new URL(`http://public.example:${upstreamPort}/redirect`),
      toLocal,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), "zip-bytes");
    assert.equal(result.headers.get("content-type"), "application/zip");
    assert.deepEqual(result.headers.getSetCookie(), ["a=1", "b=2"]);
  });

  it("fails when the host resolved to no addresses", async () => {
    await assert.rejects(
      requestWithNodeRedirects(
        new URL("http://public.example/"),
        async () => [],
      ),
      /upstream request failed/,
    );
  });

  it("refuses an upstream whose declared length exceeds the cap", async () => {
    await assert.rejects(
      requestWithNodeRedirects(
        new URL(`http://public.example:${upstreamPort}/huge-declared`),
        toLocal,
      ),
      /too large/,
    );
  });

  it("aborts an upstream that streams past the cap", async () => {
    await assert.rejects(
      requestWithNodeRedirects(
        new URL(`http://public.example:${upstreamPort}/huge-streamed`),
        toLocal,
      ),
      /too large/,
    );
  });

  it("tries every resolved address and surfaces the last transport error", async () => {
    const closed = createServer();
    const closedPort = await listen(closed);
    await close(closed);
    await assert.rejects(
      requestWithNodeRedirects(
        new URL(`http://public.example:${closedPort}/`),
        async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      ),
      /ECONNREFUSED/,
    );
  });
});

describe("requestWithCurlRedirects against a pinned upstream", () => {
  it("pins curl to the validated address and follows redirects", async () => {
    const result = await requestWithCurlRedirects(
      new URL(`http://public.example:${upstreamPort}/redirect`),
      toLocal,
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), "zip-bytes");
  });

  it("requests an IP literal without a --resolve override", async () => {
    const result = await requestWithCurlRedirects(
      new URL(`http://127.0.0.1:${upstreamPort}/plain`),
      toLocal,
    );
    assert.equal(result.body.toString(), "plain-body");
  });

  it("fails when the host resolved to no addresses", async () => {
    await assert.rejects(
      requestWithCurlRedirects(
        new URL("http://public.example/"),
        async () => [],
      ),
      /curl request failed/,
    );
  });

  it("derives the default port for --resolve from the scheme", async () => {
    for (const target of [
      "https://public.example/",
      "http://public.example/",
    ]) {
      await assert.rejects(
        requestWithCurlRedirects(new URL(target), async () => [
          { address: "127.0.0.1", family: 4 },
        ]),
        /curl failed/,
      );
    }
  });

  it("wraps an IPv6 pin in brackets for --resolve", async () => {
    // ::1 is never reachable for this IPv4-only fixture, so curl fails; the
    // error proves the hop was attempted with the IPv6 pin.
    await assert.rejects(
      requestWithCurlRedirects(
        new URL(`https://public.example:${upstreamPort}/plain`),
        async () => [{ address: "::1", family: 6 }],
      ),
      /curl failed/,
    );
  });
});

describe("requestWithValidatedRedirects limits", () => {
  const redirectTo = (location) => async () => ({
    body: Buffer.alloc(0),
    headers: new Headers({ location }),
    status: 302,
  });

  it("rejects a redirect Location that is not a URL", async () => {
    await assert.rejects(
      requestWithValidatedRedirects(
        "https://public.example/a",
        redirectTo("http://[bad"),
        async () => [PUBLIC_ADDRESS],
      ),
      /redirect URL is invalid/,
    );
  });

  it("stops after too many redirects", async () => {
    let hops = 0;
    await assert.rejects(
      requestWithValidatedRedirects(
        "https://public.example/a",
        async () => {
          hops += 1;
          return {
            body: Buffer.alloc(0),
            headers: new Headers({ location: "/a" }),
            status: 302,
          };
        },
        async () => [PUBLIC_ADDRESS],
      ),
      /too many redirects/,
    );
    assert.equal(hops, 11);
  });
});

describe("addressIsBlocked fails closed", () => {
  it("blocks malformed addresses and unknown families", () => {
    assert.equal(addressIsBlocked(123, 4), true);
    assert.equal(addressIsBlocked("not-an-ip"), true);
  });
});

describe("resolvePublicHost", () => {
  it("fails closed for an empty hostname", async () => {
    await assert.rejects(
      resolvePublicHost(undefined, async () => {
        throw new Error("ENOTFOUND");
      }),
      /could not be validated/,
    );
  });

  it("accepts bracketed public IPv6 literals without DNS", async () => {
    const results = await resolvePublicHost("[2001:4860:4860::8888]", () => {
      throw new Error("must not resolve a literal");
    });
    assert.deepEqual(results, [{ address: "2001:4860:4860::8888", family: 6 }]);
  });

  it("rejects an empty DNS answer", async () => {
    await assert.rejects(
      resolvePublicHost("empty.example", async () => []),
      /did not resolve/,
    );
  });

  it("rejects when any resolved address is private", async () => {
    await assert.rejects(
      resolvePublicHost("mixed.example", async () => [
        PUBLIC_ADDRESS,
        { address: "10.0.0.1", family: 4 },
      ]),
      ProxyValidationError,
    );
  });
});

describe("createDevServer routes", () => {
  let server;
  let base;
  const realLookup = dns.lookup;
  const realRequest = http.request;

  before(async () => {
    server = createDevServer();
    base = `http://127.0.0.1:${await listen(server)}`;
    // DNS answers a public address for *.example, and the transport dials the
    // local upstream instead, so the proxy's real validation path runs offline.
    dns.lookup = async (hostname) => {
      if (hostname.endsWith(".example")) return [PUBLIC_ADDRESS];
      throw new Error(`unexpected lookup ${hostname}`);
    };
    http.request = (url, options, callback) =>
      realRequest(
        url,
        {
          ...options,
          // Ask the pinned lookup for its single-address form, then answer
          // whichever form Node requested with the local upstream.
          lookup: (hostname, lookupOptions, done) =>
            options.lookup(
              hostname,
              { ...lookupOptions, all: false },
              (error, address, family) => {
                assert.equal(address, PUBLIC_ADDRESS.address);
                assert.equal(family, 4);
                if (lookupOptions.all) {
                  done(error, [{ address: "127.0.0.1", family: 4 }]);
                } else {
                  done(error, "127.0.0.1", 4);
                }
              },
            ),
        },
        callback,
      );
    syncBuiltinESMExports();
  });

  after(async () => {
    dns.lookup = realLookup;
    http.request = realRequest;
    syncBuiltinESMExports();
    await close(server);
  });

  it("serves index.html for / with its MIME type", async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /<html/i);
  });

  it("serves unknown extensions as octet-stream", async () => {
    const response = await fetch(`${base}/LICENSE`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    await response.arrayBuffer();
  });

  it("returns 404 for a missing file and a directory without index.html", async () => {
    assert.equal((await fetch(`${base}/does-not-exist.js`)).status, 404);
    const dir = await fetch(`${base}/src/`);
    assert.equal(dir.status, 404);
    assert.equal(await dir.text(), "Not found");
  });

  it("rejects non-GET/HEAD methods with 405", async () => {
    const response = await fetch(`${base}/index.html`, { method: "POST" });
    assert.equal(response.status, 405);
  });

  it("answers HEAD for static files", async () => {
    const response = await fetch(`${base}/index.html`, { method: "HEAD" });
    assert.equal(response.status, 200);
  });

  it("rejects a proxy request without a url parameter", async () => {
    const response = await fetch(`${base}/__addon_proxy__`);
    assert.equal(response.status, 400);
  });

  it("rejects an invalid or non-HTTP proxy target with 400", async () => {
    const invalid = await fetch(`${base}/__addon_proxy__?url=not-a-url`);
    assert.equal(invalid.status, 400);
    assert.equal(await invalid.text(), "Invalid url");
    const ftp = await fetch(
      `${base}/__addon_proxy__?url=${encodeURIComponent("ftp://public.example/a")}`,
    );
    assert.equal(ftp.status, 400);
    assert.equal(await ftp.text(), "Unsupported protocol");
  });

  it("answers 403 for a private proxy target", async () => {
    const response = await fetch(
      `${base}/__addon_proxy__?url=${encodeURIComponent("http://127.0.0.1:1/x")}`,
    );
    assert.equal(response.status, 403);
  });

  it("proxies a public addon with CORS and its disposition", async () => {
    const target = `http://addons.example:${upstreamPort}/redirect`;
    const response = await fetch(
      `${base}/__addon_proxy__?url=${encodeURIComponent(target)}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="file.zip"',
    );
    assert.equal(await response.text(), "zip-bytes");
  });

  it("defaults the proxied content type to octet-stream", async () => {
    const target = `http://addons.example:${upstreamPort}/plain`;
    const response = await fetch(
      `${base}/__addon_proxy__?url=${encodeURIComponent(target)}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(await response.text(), "plain-body");
  });

  describe("curl fallback outcomes", () => {
    // A stand-in `curl` on PATH: the fallback runs only after the Node transport
    // returned a non-2xx, and must never reach the real network from a test.
    let binDir;
    const realPath = process.env.PATH;
    before(async () => {
      binDir = await mkdtemp(join(tmpdir(), "fake-curl-"));
      const script = join(binDir, "curl");
      await writeFile(
        script,
        [
          "#!/bin/sh",
          'out=""',
          'while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done',
          'case "$FAKE_CURL_MODE" in',
          "  fail) echo boom >&2; exit 7;;",
          "  garbage) : > \"$out\"; printf 'xyz\\n';;",
          "  *) : > \"$out\"; printf '404\\n';;",
          "esac",
          "",
        ].join("\n"),
      );
      await chmod(script, 0o755);
      process.env.PATH = `${binDir}:${realPath}`;
    });
    after(async () => {
      process.env.PATH = realPath;
      delete process.env.FAKE_CURL_MODE;
      await rm(binDir, { recursive: true, force: true });
    });

    const proxy = (path) =>
      fetch(
        `${base}/__addon_proxy__?url=${encodeURIComponent(
          `http://addons.example:${upstreamPort}${path}`,
        )}`,
      );

    it("answers 502 when the fallback also returns a non-2xx", async () => {
      process.env.FAKE_CURL_MODE = "404";
      const response = await proxy("/missing");
      assert.equal(response.status, 502);
      assert.equal(await response.text(), "Upstream fetch failed");
    });

    it("answers 502 when the fallback transport fails", async () => {
      process.env.FAKE_CURL_MODE = "fail";
      assert.equal((await proxy("/missing")).status, 502);
    });

    it("answers 502 when curl reports an invalid HTTP status", async () => {
      process.env.FAKE_CURL_MODE = "garbage";
      assert.equal((await proxy("/missing")).status, 502);
    });
  });
});
