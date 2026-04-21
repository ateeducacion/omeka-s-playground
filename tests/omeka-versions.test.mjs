import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_PHP_VERSIONS,
  buildManifestFilename,
  buildRuntimeId,
  buildRuntimeLabel,
  DEFAULT_OMEKA_VERSION,
  DEFAULT_PHP_VERSION,
  getCompatiblePhpVersions,
  getDefaultOmekaVersion,
  getOmekaVersionMetadata,
  isCompatibleCombination,
  OMEKA_VERSIONS,
  parseQueryParams,
  parseRuntimeId,
  resolveOmekaVersion,
  resolveRuntimeConfig,
  resolveRuntimeSelection,
  resolveVersions,
} from "../src/shared/omeka-versions.js";

describe("OMEKA_VERSIONS", () => {
  it("includes 4.1.1 and 4.2.0 and picks 4.2.0 as default", () => {
    const versions = OMEKA_VERSIONS.map((entry) => entry.version);
    assert.ok(versions.includes("4.1.1"));
    assert.ok(versions.includes("4.2.0"));
    assert.equal(getDefaultOmekaVersion().version, "4.2.0");
    assert.equal(DEFAULT_OMEKA_VERSION, "4.2.0");
  });

  it("exposes the full PHP matrix and a sensible default", () => {
    assert.deepEqual(ALL_PHP_VERSIONS, ["8.1", "8.2", "8.3", "8.4", "8.5"]);
    assert.equal(DEFAULT_PHP_VERSION, "8.3");
  });
});

describe("getOmekaVersionMetadata", () => {
  it("matches by exact version string", () => {
    assert.equal(getOmekaVersionMetadata("4.1.1")?.version, "4.1.1");
    assert.equal(getOmekaVersionMetadata("4.2.0")?.version, "4.2.0");
  });

  it("returns null for unknown versions", () => {
    assert.equal(getOmekaVersionMetadata("3.0"), null);
    assert.equal(getOmekaVersionMetadata(null), null);
  });
});

describe("resolveOmekaVersion", () => {
  it("accepts exact version strings", () => {
    assert.equal(resolveOmekaVersion("4.1.1"), "4.1.1");
    assert.equal(resolveOmekaVersion("4.2.0"), "4.2.0");
  });

  it("resolves a major.minor request to the declared patch version", () => {
    assert.equal(resolveOmekaVersion("4.1"), "4.1.1");
    assert.equal(resolveOmekaVersion("4.2"), "4.2.0");
  });

  it("returns null for unknown input", () => {
    assert.equal(resolveOmekaVersion("3.5"), null);
    assert.equal(resolveOmekaVersion(""), null);
    assert.equal(resolveOmekaVersion(undefined), null);
  });
});

describe("getCompatiblePhpVersions / isCompatibleCombination", () => {
  it("returns the declared PHP versions for each Omeka version", () => {
    assert.deepEqual(getCompatiblePhpVersions("4.1.1"), [
      "8.1",
      "8.2",
      "8.3",
      "8.4",
      "8.5",
    ]);
  });

  it("detects invalid combinations", () => {
    assert.equal(isCompatibleCombination("8.3", "4.1.1"), true);
    assert.equal(isCompatibleCombination("7.4", "4.2.0"), false);
    assert.equal(isCompatibleCombination("8.3", "nope"), false);
  });
});

describe("buildRuntimeId / parseRuntimeId", () => {
  it("round-trips modern runtime ids", () => {
    const id = buildRuntimeId("8.3", "4.2.0");
    assert.equal(id, "php83-omeka420");
    assert.deepEqual(parseRuntimeId(id), {
      phpVersion: "8.3",
      omekaVersion: "4.2.0",
    });

    const id411 = buildRuntimeId("8.3", "4.1.1");
    assert.equal(id411, "php83-omeka411");
    assert.deepEqual(parseRuntimeId(id411), {
      phpVersion: "8.3",
      omekaVersion: "4.1.1",
    });
  });

  it("maps legacy phpXY ids to the default Omeka version", () => {
    assert.deepEqual(parseRuntimeId("php83"), {
      phpVersion: "8.3",
      omekaVersion: DEFAULT_OMEKA_VERSION,
    });
    assert.deepEqual(parseRuntimeId("php81-cgi"), {
      phpVersion: "8.1",
      omekaVersion: DEFAULT_OMEKA_VERSION,
    });
  });

  it("returns null for unrecognised ids", () => {
    assert.equal(parseRuntimeId(null), null);
    assert.equal(parseRuntimeId("garbage"), null);
  });
});

describe("resolveVersions / resolveRuntimeSelection", () => {
  it("prefers explicit params over other inputs", () => {
    assert.deepEqual(
      resolveVersions({
        php: "8.4",
        omeka: "4.1.1",
        runtimeId: "php83-omeka420",
      }),
      { phpVersion: "8.4", omekaVersion: "4.1.1" },
    );
  });

  it("falls back to the runtime id when params are missing", () => {
    assert.deepEqual(resolveVersions({ runtimeId: "php82-omeka411" }), {
      phpVersion: "8.2",
      omekaVersion: "4.1.1",
    });
  });

  it("falls back to defaults when nothing is supplied", () => {
    assert.deepEqual(resolveVersions({}), {
      phpVersion: DEFAULT_PHP_VERSION,
      omekaVersion: DEFAULT_OMEKA_VERSION,
    });
  });

  it("drops incompatible explicit PHP versions", () => {
    // PHP 7.4 is not in the compatibility list — the resolver should fall
    // back to the Omeka version's default.
    const resolved = resolveVersions({ php: "7.4", omeka: "4.2.0" });
    assert.equal(resolved.omekaVersion, "4.2.0");
    assert.notEqual(resolved.phpVersion, "7.4");
  });

  it("buildRuntimeLabel synthesises a readable label", () => {
    assert.equal(buildRuntimeLabel("8.3", "4.1.1"), "PHP 8.3 + Omeka S 4.1.1");
  });

  it("resolveRuntimeSelection returns a consistent runtime id", () => {
    const selection = resolveRuntimeSelection({ omeka: "4.1", php: "8.3" });
    assert.equal(selection.omekaVersion, "4.1.1");
    assert.equal(selection.phpVersion, "8.3");
    assert.equal(selection.runtimeId, "php83-omeka411");
  });
});

describe("resolveRuntimeConfig", () => {
  const fakeConfig = {
    runtimes: [
      {
        id: "php83-omeka420",
        label: "PHP 8.3 + Omeka 4.2.0",
        phpVersion: "8.3",
        omekaVersion: "4.2.0",
        default: true,
      },
      {
        id: "php83-omeka411",
        label: "PHP 8.3 + Omeka 4.1.1",
        phpVersion: "8.3",
        omekaVersion: "4.1.1",
        default: false,
      },
    ],
  };

  it("returns the exact runtime entry when present", () => {
    const resolved = resolveRuntimeConfig(fakeConfig, {
      runtimeId: "php83-omeka420",
    });
    assert.equal(resolved.id, "php83-omeka420");
    assert.equal(resolved.label, "PHP 8.3 + Omeka 4.2.0");
  });

  it("synthesises a runtime entry for unconfigured combinations", () => {
    const resolved = resolveRuntimeConfig(fakeConfig, {
      runtimeId: "php85-omeka420",
    });
    assert.equal(resolved.id, "php85-omeka420");
    assert.equal(resolved.phpVersion, "8.5");
    assert.equal(resolved.omekaVersion, "4.2.0");
    assert.equal(
      resolved.label,
      "PHP 8.5 + Omeka S 4.2.0 (experimental SQLite)",
    );
  });

  it("returns null when the config has no runtimes", () => {
    assert.equal(resolveRuntimeConfig({ runtimes: [] }, {}), null);
    assert.equal(resolveRuntimeConfig(null, {}), null);
  });
});

describe("parseQueryParams", () => {
  it("reads omeka/php params from a URL string", () => {
    const parsed = parseQueryParams("https://example.com/?omeka=4.1.1&php=8.4");
    assert.equal(parsed.omeka, "4.1.1");
    assert.equal(parsed.php, "8.4");
  });

  it("reads from an existing URL object", () => {
    const url = new URL("https://example.com/?omekaVersion=4.2.0");
    const parsed = parseQueryParams(url);
    assert.equal(parsed.omekaVersion, "4.2.0");
  });
});

describe("buildManifestFilename", () => {
  it("produces the declared manifest filename for each version", () => {
    assert.equal(buildManifestFilename("4.1.1"), "4.1.1.json");
    assert.equal(buildManifestFilename("4.2.0"), "4.2.0.json");
  });

  it("falls back to latest.json for unknown versions", () => {
    assert.equal(buildManifestFilename("9.9.9"), "latest.json");
  });
});
