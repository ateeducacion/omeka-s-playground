import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The generated playground-install.php must boot through Omeka's bootstrap.php,
// not require vendor/autoload.php directly. bootstrap.php registers a prepended
// autoloader that swaps in the patched Doctrine proxy classes under
// application/data/overrides/, which is what makes the core's intentional
// setAutoGenerateProxyClasses(-1) acceptable. Bypassing bootstrap.php loads the
// stricter vendor ProxyFactory and boot dies with "Invalid auto generate mode -1".
const bootstrapSrc = readFileSync(
  fileURLToPath(new URL("../src/runtime/bootstrap.js", import.meta.url)),
  "utf8",
);

function extractInstallScriptTemplate(src) {
  const start = src.indexOf("function buildInstallScript(");
  assert.ok(start !== -1, "buildInstallScript must exist in bootstrap.js");
  // The template literal that produces the PHP install stub starts at `<?php`.
  const phpStart = src.indexOf("<?php", start);
  assert.ok(phpStart !== -1, "buildInstallScript must emit a PHP script");
  // Bound the search to the first chunk of the template (the boot preamble).
  return src.slice(phpStart, phpStart + 600);
}

describe("playground-install.php boot preamble", () => {
  const preamble = extractInstallScriptTemplate(bootstrapSrc);

  it("boots through Omeka's bootstrap.php (carries the override autoloader)", () => {
    assert.ok(
      /require\s+'\$\{OMEKA_ROOT\}\/bootstrap\.php'/.test(preamble),
      "install stub must require ${OMEKA_ROOT}/bootstrap.php",
    );
  });

  it("does not bypass bootstrap.php with a bare vendor/autoload require", () => {
    assert.ok(
      !preamble.includes("/vendor/autoload.php"),
      "install stub must not require vendor/autoload.php directly; bootstrap.php does it",
    );
  });

  it("still applies the configured timezone after bootstrap", () => {
    assert.ok(
      preamble.includes("date_default_timezone_set('${config.timezone}')"),
      "install stub must set the configured timezone",
    );
  });
});
