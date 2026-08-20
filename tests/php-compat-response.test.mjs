import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { phpResponseToResponse } from "../src/runtime/php-compat.js";

const BODY = new TextEncoder().encode("<html>hello</html>");

function phpResponse(httpStatusCode, headers = {}, bytes = BODY) {
  return { httpStatusCode, headers, bytes };
}

describe("phpResponseToResponse null-body statuses", () => {
  it("drops the body on 204 so the Response can be constructed", () => {
    const response = phpResponseToResponse(
      phpResponse(204, { "content-type": ["text/html"] }),
    );
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("content-type"), "text/html");
  });

  it("drops the body on 304 (conditional GET)", () => {
    const response = phpResponseToResponse(
      phpResponse(304, { etag: ['"abc"'] }),
    );
    assert.equal(response.status, 304);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("etag"), '"abc"');
  });

  it("drops the body on 205", () => {
    // 101 and 103 are in the spec's null-body list too, but the Response
    // constructor rejects any status below 200 outright, so they are not
    // representable here.
    const response = phpResponseToResponse(phpResponse(205));
    assert.equal(response.status, 205);
    assert.equal(response.body, null);
  });

  it("still carries the body on 200", async () => {
    const response = phpResponseToResponse(
      phpResponse(200, { "content-type": ["text/html"] }),
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<html>hello</html>");
  });
});

describe("phpResponseToResponse invalid headers", () => {
  it("skips a malformed header name and keeps the rest of the response", async () => {
    const response = phpResponseToResponse(
      phpResponse(200, {
        // A space is illegal in a header name; Headers.append() throws
        // "Invalid name" on it.
        "X Invalid Name": ["boom"],
        "content-type": ["text/html"],
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html");
    // Headers.get() validates the name too, so assert over the kept keys.
    assert.deepEqual([...response.headers.keys()], ["content-type"]);
    assert.equal(await response.text(), "<html>hello</html>");
  });

  it("skips a malformed header value without aborting the response", () => {
    const response = phpResponseToResponse(
      phpResponse(200, { "x-broken": ["bad\nvalue"], "x-ok": ["fine"] }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-ok"), "fine");
    assert.equal(response.headers.get("x-broken"), null);
  });
});
