import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  ProxyValidationError,
  addressIsBlocked,
  fetchAddon,
  requestWithNodeRedirects,
  requestWithValidatedRedirects,
  resolvePublicHost,
} from "../scripts/dev-server.mjs";

function response(status, location = null, body = "") {
  const headers = new Headers();
  if (location) headers.set("location", location);
  return { body: Buffer.from(body), headers, status };
}

describe("dev server SSRF guard", () => {
  let localServer;
  let localUrl;
  let localRequests = 0;
  let localHostHeader = null;

  before(async () => {
    localServer = createServer((request, serverResponse) => {
      localRequests += 1;
      localHostHeader = request.headers.host || null;
      serverResponse.end("local secret");
    });
    await new Promise((resolveListen) => {
      localServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = localServer.address();
    localUrl = `http://127.0.0.1:${address.port}/secret`;
  });

  after(async () => {
    await new Promise((resolveClose, rejectClose) => {
      localServer.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  });

  it("blocks complete private and special-use IPv4 ranges", () => {
    assert.equal(addressIsBlocked("100.64.0.1", 4), true);
    assert.equal(addressIsBlocked("100.127.255.254", 4), true);
    assert.equal(addressIsBlocked("100.128.0.1", 4), false);
    assert.equal(addressIsBlocked("127.0.0.1", 4), true);
    assert.equal(addressIsBlocked("169.254.1.1", 4), true);
    assert.equal(addressIsBlocked("224.0.0.1", 4), true);
    assert.equal(addressIsBlocked("255.255.255.255", 4), true);
    assert.equal(addressIsBlocked("8.8.8.8", 4), false);
  });

  it("matches IPv6 CIDRs instead of textual prefixes", () => {
    assert.equal(addressIsBlocked("fe80::1", 6), true);
    assert.equal(addressIsBlocked("fea0::1", 6), true);
    assert.equal(addressIsBlocked("febf:ffff::1", 6), true);
    assert.equal(addressIsBlocked("fec0::1", 6), true);
    assert.equal(addressIsBlocked("feff:ffff::1", 6), true);
    assert.equal(addressIsBlocked("64:ff9b::7f00:1", 6), true);
    assert.equal(addressIsBlocked("64:ff9b:1::1", 6), true);
    assert.equal(addressIsBlocked("ff02::1", 6), true);
    assert.equal(addressIsBlocked("2001:4860:4860::8888", 6), false);
  });

  it("blocks private IPv4 addresses embedded in IPv6", () => {
    assert.equal(addressIsBlocked("::ffff:127.0.0.1", 6), true);
    assert.equal(addressIsBlocked("::ffff:7f00:1", 6), true);
    assert.equal(addressIsBlocked("::192.168.1.1", 6), true);
    assert.equal(addressIsBlocked("::ffff:8.8.8.8", 6), false);
  });

  it("fails closed when DNS resolution cannot be validated", async () => {
    await assert.rejects(
      resolvePublicHost("unresolvable.example", async () => {
        throw new Error("DNS unavailable");
      }),
      ProxyValidationError,
    );
  });

  it("pins the Node transport to the validated DNS address", async () => {
    localRequests = 0;
    localHostHeader = null;
    const address = localServer.address();
    const target = new URL(`http://public.example:${address.port}/pinned`);
    const result = await requestWithNodeRedirects(target, async () => [
      { address: "127.0.0.1", family: 4 },
    ]);

    assert.equal(result.body.toString(), "local secret");
    assert.equal(localRequests, 1);
    assert.equal(localHostHeader, `public.example:${address.port}`);
  });

  it(
    "rejects a public redirect to a local HTTP service before requesting it",
    async () => {
      localRequests = 0;
      let requestCount = 0;
      const requestSingleHop = async () => {
        requestCount += 1;
        return response(302, localUrl);
      };
      const resolveHost = async (hostname) => {
        if (hostname === "public.example") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        return resolvePublicHost(hostname);
      };

      await assert.rejects(
        requestWithValidatedRedirects(
          "https://public.example/addon.zip",
          requestSingleHop,
          resolveHost,
        ),
        ProxyValidationError,
      );
      assert.equal(requestCount, 1);
      assert.equal(localRequests, 0);
    },
  );

  it("does not invoke curl after a validation rejection", async () => {
    let curlCalled = false;
    await assert.rejects(
      fetchAddon(new URL("https://public.example/addon.zip"), {
        nodeRequest: async () => {
          throw new ProxyValidationError("target host is not allowed");
        },
        curlRequest: async () => {
          curlCalled = true;
          return response(200, null, "unexpected");
        },
      }),
      ProxyValidationError,
    );
    assert.equal(curlCalled, false);
  });

  it(
    "applies redirect validation inside the curl transport fallback",
    async () => {
      localRequests = 0;
      let curlHopCount = 0;
      const resolveHost = async (hostname) => {
        if (hostname === "public.example") {
          return [{ address: "93.184.216.34", family: 4 }];
        }
        return resolvePublicHost(hostname);
      };

      await assert.rejects(
        fetchAddon(new URL("https://public.example/addon.zip"), {
          nodeRequest: async () => {
            throw new Error("simulated TLS fingerprint rejection");
          },
          curlRequest: (target) =>
            requestWithValidatedRedirects(
              target,
              async () => {
                curlHopCount += 1;
                return response(302, localUrl);
              },
              resolveHost,
            ),
        }),
        ProxyValidationError,
      );
      assert.equal(curlHopCount, 1);
      assert.equal(localRequests, 0);
    },
  );

  it(
    "uses curl after a transport failure and returns its successful response",
    async () => {
      const result = await fetchAddon(
        new URL("https://public.example/addon.zip"),
        {
          nodeRequest: async () => {
            throw new Error("simulated TLS failure");
          },
          curlRequest: async () => response(200, null, "zip bytes"),
        },
      );
      assert.equal(result.body.toString(), "zip bytes");
    },
  );

  it("rejects redirects to unsupported protocols", async () => {
    await assert.rejects(
      requestWithValidatedRedirects(
        "https://public.example/addon.zip",
        async () => response(302, "file:///etc/passwd"),
        async () => [{ address: "93.184.216.34", family: 4 }],
      ),
      ProxyValidationError,
    );
  });
});
