import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCoreExtractScript } from "../src/runtime/core-extract-script.js";

describe("buildCoreExtractScript", () => {
  const script = buildCoreExtractScript(
    "/tmp/omeka-core.zip",
    "/tmp/omeka-core-stage",
    "/www/omeka",
  );

  it("extracts the core with PHP ZipArchive into the target root", () => {
    assert.ok(script.startsWith("<?php"));
    assert.match(script, /new ZipArchive\(\)/);
    assert.match(script, /->extractTo\(\$stage\)/);
    assert.match(script, /\$zipPath = '\/tmp\/omeka-core\.zip'/);
    assert.match(script, /\$target = '\/www\/omeka'/);
  });

  it("descends into a lone wrapping folder, then moves it into place", () => {
    assert.match(script, /count\(\$top\) === 1 && is_dir/);
    assert.match(script, /@rename\(\$src, \$target\)/);
  });

  it("declares the sentinel contract and probes ext/zip", () => {
    assert.match(script, /class_exists\('ZipArchive'\)/);
    assert.match(script, /return 'NO_ZIP_EXT'/);
    assert.match(script, /return 'INSTALL_OK ' \. \$count/);
    assert.match(script, /INSTALL_ERR/);
  });

  it("removes the temp zip on success", () => {
    assert.match(script, /@unlink\(\$zipPath\)/);
  });

  it("escapes single quotes in paths to keep the PHP literal safe", () => {
    const evil = buildCoreExtractScript("/tmp/a'b.zip", "/tmp/s", "/www/x");
    assert.match(evil, /\/tmp\/a\\'b\.zip'/);
    assert.doesNotMatch(evil, /\/tmp\/a'b\.zip'/);
  });
});
