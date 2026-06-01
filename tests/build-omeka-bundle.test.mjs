import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../scripts/build-omeka-bundle.sh", import.meta.url),
);
const script = readFileSync(scriptPath, "utf8");

// Valid Doctrine proxy auto-generate modes (doctrine/common AUTOGENERATE_MODES).
// Anything outside this set throws "Invalid auto generate mode" on >= 3.5.
const VALID_AUTOGENERATE_MODES = new Set(["0", "1", "2", "3", "4"]);

describe("build-omeka-bundle.sh doctrine proxy patch", () => {
  it("rewrites Omeka's setAutoGenerateProxyClasses(-1) to a valid mode", () => {
    // Omeka core ships this call relying on old Doctrine ignoring -1.
    // doctrine/common >= 3.5 validates the mode and crashes boot otherwise.
    // Strip shell/perl backslash escaping so the assertion ignores how many
    // backslashes the regex needs and just checks the substitution intent.
    const unescaped = script.replace(/\\/g, "");
    assert.ok(
      unescaped.includes(
        "s/setAutoGenerateProxyClasses(-1)/setAutoGenerateProxyClasses(0)/",
      ),
      "build script must rewrite setAutoGenerateProxyClasses(-1) -> (0)",
    );

    // The replacement (right-hand side of the perl s///) must be a valid mode.
    const replacementMatch = script.match(
      /setAutoGenerateProxyClasses\((\d+)\)/,
    );
    assert.ok(
      replacementMatch,
      "build script must contain the replacement mode value",
    );
    assert.ok(
      VALID_AUTOGENERATE_MODES.has(replacementMatch[1]),
      `replacement mode ${replacementMatch[1]} must be a valid Doctrine AUTOGENERATE mode`,
    );
  });

  it("the perl substitution turns the upstream call into a valid mode", () => {
    // Mirror exactly what the build script runs against EntityManagerFactory.php.
    const sample = "        $emConfig->setAutoGenerateProxyClasses(-1);\n";
    const out = execFileSync(
      "perl",
      [
        "-0pe",
        "s/setAutoGenerateProxyClasses\\(-1\\)/setAutoGenerateProxyClasses(0)/",
      ],
      { input: sample },
    ).toString();

    assert.equal(out, "        $emConfig->setAutoGenerateProxyClasses(0);\n");
    const mode = out.match(/setAutoGenerateProxyClasses\(([0-9-]+)\)/)[1];
    assert.ok(VALID_AUTOGENERATE_MODES.has(mode));
    assert.ok(!out.includes("(-1)"));
  });
});
