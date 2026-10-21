// CLI behaviour of the build/deploy scripts. Each script runs as a real child
// process (the way npm, make and CI invoke it) against temp directories, with
// external tools (wrangler) replaced by a fake on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { readUstarTar } from "../scripts/lib/tar-ustar.mjs";
import { writeBuildVersion } from "../scripts/write-build-version.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "omeka-build-scripts-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

let tempCounter = 0;
function tempDir() {
  const dir = join(tempRoot, String(tempCounter++));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runScript(script, args = [], options = {}) {
  return spawnSync(
    process.execPath,
    [join(repoDir, "scripts", script), ...args],
    {
      cwd: options.cwd || repoDir,
      encoding: "utf8",
      env: { ...process.env, ...options.env },
    },
  );
}

describe("write-build-version.mjs", () => {
  it("prints only the Build ID with --print-version, honouring BUILD_VERSION", () => {
    const result = runScript("write-build-version.mjs", ["--print-version"], {
      env: { BUILD_VERSION: "20260101T000000Z-deadbeef" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "20260101T000000Z-deadbeef\n");
  });

  it("writes the JS module and JSON metadata under the repo dir", () => {
    const dir = tempDir();
    const logs = [];
    const metadata = writeBuildVersion({
      argv: [],
      env: { BUILD_SHA: "0123456789abcdef0123456789abcdef01234567" },
      repoDir: dir,
      log: (line) => logs.push(line),
    });
    assert.equal(metadata.gitSha, "01234567");
    // The temp dir is not a git checkout, so git reports nothing and the build is clean.
    assert.equal(metadata.dirty, false);
    assert.match(metadata.buildVersion, /^\d{8}T\d{6}Z-01234567$/);
    const json = JSON.parse(
      readFileSync(join(dir, "assets/build-version.json"), "utf8"),
    );
    assert.deepEqual(json, metadata);
    const js = readFileSync(
      join(dir, "src/generated/build-version.js"),
      "utf8",
    );
    assert.ok(
      js.includes(
        `export const BUILD_VERSION = ${JSON.stringify(metadata.buildVersion)};`,
      ),
    );
    assert.deepEqual(logs, [`Wrote build metadata ${metadata.buildVersion}`]);
  });

  it("reads the revision from git when run inside a checkout", () => {
    const chunks = [];
    const metadata = writeBuildVersion({
      argv: ["--print-version"],
      env: {},
      stdout: { write: (chunk) => chunks.push(chunk) },
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    assert.equal(metadata.gitSha, head.slice(0, 8));
    assert.deepEqual(chunks, [`${metadata.buildVersion}\n`]);
  });
});

describe("generate-manifest.mjs", () => {
  it("describes the bundle relative to the manifest with its size and hash", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "manifests"));
    mkdirSync(join(dir, "bundles"));
    const bundle = join(dir, "bundles/omeka.tar.zst");
    writeFileSync(bundle, "bundle-bytes");
    const manifestPath = join(dir, "manifests/latest.json");
    const result = runScript("generate-manifest.mjs", [
      "--manifest",
      manifestPath,
      "--bundle",
      bundle,
      "--channel",
      "stable",
      "--release",
      "4.1.1",
      "--sourceRepository",
      "omeka/omeka-s",
      "--sourceBranch",
      "v4.1.1",
      "--sourceCommit",
      "abc123",
      "--fileCount",
      "42",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 2);
    assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.release, "4.1.1");
    assert.deepEqual(manifest.source, {
      repository: "omeka/omeka-s",
      branch: "v4.1.1",
      commit: "abc123",
    });
    assert.deepEqual(manifest.bundle, {
      format: "tar.zst",
      container: "tar",
      codec: "zstd",
      path: "../bundles/omeka.tar.zst",
      size: 12,
      sha256: createHash("sha256").update("bundle-bytes").digest("hex"),
      fileCount: 42,
    });
  });

  it("omits the commit and defaults the file count when not given", () => {
    const dir = tempDir();
    const bundle = join(dir, "b.tar.zst");
    writeFileSync(bundle, "");
    const manifestPath = join(dir, "m.json");
    const result = runScript("generate-manifest.mjs", [
      "positional-is-ignored",
      "--manifest",
      manifestPath,
      "--bundle",
      bundle,
      "--sourceRepository",
      "r",
      "--sourceBranch",
      "b",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest.source, { repository: "r", branch: "b" });
    assert.equal(manifest.bundle.path, "b.tar.zst");
    assert.equal(manifest.bundle.fileCount, 0);
  });

  it("fails on a flag without a value", () => {
    const result = runScript("generate-manifest.mjs", [
      "--manifest",
      "--bundle",
      "x",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing value for --manifest/);
  });
});

describe("build-tar-zst-bundle.mjs", () => {
  it("prints usage and fails without arguments", () => {
    const result = runScript("build-tar-zst-bundle.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: build-tar-zst-bundle\.mjs/);
  });

  it("packs a staged tree into a zstd tar and reports its stats", () => {
    const stage = tempDir();
    mkdirSync(join(stage, "application/src"), { recursive: true });
    writeFileSync(join(stage, "index.php"), "<?php echo 1;");
    writeFileSync(join(stage, "application/src/Module.php"), "module");
    const out = join(tempDir(), "omeka.tar.zst");
    const result = runScript("build-tar-zst-bundle.mjs", [stage, out]);
    assert.equal(result.status, 0, result.stderr);

    const compressed = readFileSync(out);
    const stats = JSON.parse(result.stdout);
    assert.deepEqual(stats, {
      fileCount: 2,
      dirCount: 0,
      bytes: compressed.length,
      sha256: createHash("sha256").update(compressed).digest("hex"),
      uncompressedBytes: "<?php echo 1;".length + "module".length,
    });
    const files = Object.fromEntries(
      readUstarTar(zlib.zstdDecompressSync(compressed))
        .filter((entry) => entry.type !== "dir")
        .map((entry) => [entry.name, Buffer.from(entry.data).toString()]),
    );
    assert.deepEqual(files, {
      "application/src/Module.php": "module",
      "index.php": "<?php echo 1;",
    });
  });

  it("is deterministic for the same tree", () => {
    const stage = tempDir();
    writeFileSync(join(stage, "a.txt"), "a");
    const first = JSON.parse(
      runScript("build-tar-zst-bundle.mjs", [
        stage,
        join(tempDir(), "1.tar.zst"),
      ]).stdout,
    );
    const second = JSON.parse(
      runScript("build-tar-zst-bundle.mjs", [
        stage,
        join(tempDir(), "2.tar.zst"),
      ]).stdout,
    );
    assert.equal(first.sha256, second.sha256);
  });
});

describe("cleanup-cloudflare-pages.mjs", () => {
  // A fake `npx` on PATH that answers `wrangler pages deployment list` with the
  // fixture in FAKE_DEPLOYMENTS, records every call, and fails deletes of the
  // id in FAKE_FAIL_ID.
  function fakeWrangler(deployments, { failId = "", listFails = false } = {}) {
    const bin = tempDir();
    const calls = join(bin, "calls.log");
    const npx = join(bin, "npx");
    writeFileSync(
      npx,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[3] === "list") {
  if (process.env.FAKE_LIST_FAILS) { console.error("auth error"); process.exit(1); }
  process.stdout.write(process.env.FAKE_DEPLOYMENTS);
} else if (args[4] === process.env.FAKE_FAIL_ID) {
  console.error("not found"); process.exit(1);
}
`,
    );
    chmodSync(npx, 0o755);
    return {
      calls: () =>
        existsSync(calls)
          ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse)
          : [],
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DEPLOYMENTS: JSON.stringify(deployments),
        FAKE_FAIL_ID: failId,
        FAKE_LIST_FAILS: listFails ? "1" : "",
        CLOUDFLARE_PAGES_PROJECT: "omeka-s-playground",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_PAGES_BRANCH: "",
        CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "",
        CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "",
      },
    };
  }

  const deployment = (Id, Environment, Branch) => ({
    Id,
    Environment,
    Branch,
    Source: "abc",
  });

  it("requires the project name and account id", () => {
    const noProject = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: { CLOUDFLARE_PAGES_PROJECT: "", CLOUDFLARE_ACCOUNT_ID: "a" },
    });
    assert.notEqual(noProject.status, 0);
    assert.match(noProject.stderr, /CLOUDFLARE_PAGES_PROJECT is required/);
    const noAccount = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: { CLOUDFLARE_PAGES_PROJECT: "p", CLOUDFLARE_ACCOUNT_ID: "" },
    });
    assert.notEqual(noAccount.status, 0);
    assert.match(noAccount.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
  });

  it("keeps the newest deployment per environment and branch", () => {
    const fake = fakeWrangler(
      [
        deployment("new-main", "production", "main"),
        deployment("new-pr", "preview", "pr-1"),
        deployment("old-main", "production", "main"),
        deployment("old-pr", "preview", "pr-1"),
      ],
      { failId: "old-pr" },
    );
    const result = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: fake.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deleted old-main \(production\/main\/abc\)/);
    assert.match(
      result.stdout,
      /Skipped old-pr \(preview\/pr-1\/abc\): .*failed/,
    );
    const calls = fake.calls();
    assert.deepEqual(calls[0], [
      "wrangler",
      "pages",
      "deployment",
      "list",
      "--project-name",
      "omeka-s-playground",
      "--json",
    ]);
    assert.deepEqual(
      calls.slice(1).map((args) => args[4]),
      ["old-main", "old-pr"],
    );
    assert.deepEqual(calls[1].slice(5), [
      "--project-name",
      "omeka-s-playground",
      "--force",
    ]);
  });

  it("deletes every deployment of the target branch when asked", () => {
    const fake = fakeWrangler([
      deployment("pr-a", "preview", "pr-9"),
      deployment("pr-b", "preview", "pr-9"),
      deployment("main", "production", "main"),
    ]);
    const result = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: {
        ...fake.env,
        CLOUDFLARE_PAGES_BRANCH: "pr-9",
        CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "true",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake
        .calls()
        .slice(1)
        .map((args) => args[4]),
      ["pr-a", "pr-b"],
    );
  });

  it("only reports deletions in dry-run mode", () => {
    const fake = fakeWrangler([
      deployment("keep", "preview", "x"),
      deployment("stale", "preview", "x"),
    ]);
    const result = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: { ...fake.env, CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "true" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] Would delete stale/);
    assert.equal(fake.calls().length, 1);
  });

  it("exits cleanly when nothing is stale", () => {
    const fake = fakeWrangler([deployment("only", "production", "main")]);
    const result = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: fake.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /No stale Cloudflare Pages deployments found for omeka-s-playground/,
    );
  });

  it("fails with wrangler's output when listing fails", () => {
    const fake = fakeWrangler([], { listFails: true });
    const result = runScript("cleanup-cloudflare-pages.mjs", [], {
      env: fake.env,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /wrangler pages deployment list .* failed\nauth error/,
    );
  });
});

describe("prepare-runtime.mjs and sync-browser-deps.mjs", () => {
  // Both only touch git-ignored directories of the checkout and are idempotent,
  // so they run for real.
  it("creates the cache, asset and vendor directories", () => {
    const result = runScript("prepare-runtime.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Prepared cache, asset, and vendor directories/,
    );
    for (const dir of [
      ".cache/omeka-source",
      "assets/omeka",
      "assets/manifests",
      "vendor",
    ]) {
      assert.ok(statSync(join(repoDir, dir)).isDirectory(), dir);
    }
  });

  it("copies fflate into vendor/", () => {
    const result = runScript("sync-browser-deps.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Synced browser dependencies into vendor\//);
    const pkg = JSON.parse(
      readFileSync(join(repoDir, "vendor/fflate/package.json"), "utf8"),
    );
    const installed = JSON.parse(
      readFileSync(join(repoDir, "node_modules/fflate/package.json"), "utf8"),
    );
    assert.equal(pkg.version, installed.version);
  });
});

describe("esbuild.worker.mjs", () => {
  // The real production build (~2 s): it is the only way to prove the plugins
  // stub unsupported PHP versions, emit each supported .wasm and keep the
  // Service Worker a classic script.
  it("bundles the worker, schema validator and classic Service Worker", async () => {
    const result = runScript("esbuild.worker.mjs");
    assert.equal(result.status, 0, result.stderr);
    const { ALL_PHP_VERSIONS } = await import(
      pathToFileURL(join(repoDir, "src/shared/omeka-versions.js")).href
    );
    const kept = ALL_PHP_VERSIONS.map((v) => v.replace(".", "-"));
    assert.match(
      result.stdout,
      new RegExp(`bundled PHP runtimes: ${kept.join(", ")}`),
    );

    const emitted = readdirSync(join(repoDir, "dist"));
    for (const version of kept) {
      const prefix = `php_${version.replace("-", "_")}-`;
      assert.ok(
        emitted.some((f) => f.startsWith(prefix) && f.endsWith(".wasm")),
        `missing wasm for PHP ${version}`,
      );
    }
    assert.ok(!emitted.some((f) => f.startsWith("php_7_4-")));

    const worker = readFileSync(
      join(repoDir, "dist/php-worker.bundle.js"),
      "utf8",
    );
    assert.ok(
      worker.startsWith(
        'const __APP_ROOT__ = new URL("../", import.meta.url).href;',
      ),
    );
    assert.match(
      worker,
      /PHP runtime not bundled in this build: @php-wasm\/web-7-4/,
    );
    assert.match(
      worker,
      /https:\/\/unpkg\.com\/@php-wasm\/web@[^/]+\/shared\/icu\.dat/,
    );

    const sw = readFileSync(join(repoDir, "sw.bundle.js"), "utf8");
    assert.ok(!/^\s*(import|export)\s/m.test(sw), "SW bundle must be classic");
    assert.ok(sw.startsWith("(() => {"), "SW bundle must be an IIFE");

    const schema = await import(
      `${pathToFileURL(join(repoDir, "dist/blueprint-schema.bundle.js")).href}?t=${Date.now()}`
    );
    assert.ok(Object.keys(schema).length > 0);
  });
});
