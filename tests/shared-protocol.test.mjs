import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, formatErrorDetail } from "../src/shared/protocol.js";

test("formatErrorDetail keeps the error message when the stack omits it", () => {
  // Firefox and Safari: the stack has only frames, no "Name: message" line.
  const firefox = new Error("needs what this installation lacks");
  firefox.name = "PHPExecutionFailureError";
  firefox.stack = "run@http://localhost/dist/php-worker.bundle.js:1:1\n";
  assert.equal(
    formatErrorDetail(firefox),
    "PHPExecutionFailureError: needs what this installation lacks\nrun@http://localhost/dist/php-worker.bundle.js:1:1",
  );

  // Chromium: the stack already starts with "Name: message".
  const chromium = new Error("boom");
  assert.equal(formatErrorDetail(chromium), chromium.stack);

  assert.equal(formatErrorDetail("plain"), "plain");
  assert.equal(formatErrorDetail(null), "Unknown error");
  assert.equal(formatErrorDetail({ a: 1 }), '{\n  "a": 1\n}');
});

test("escapeHtml turns markup characters into text", () => {
  assert.equal(
    escapeHtml("<script>alert('x')</script> & \"q\""),
    "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;",
  );
  assert.equal(escapeHtml(503), "503");
});
