import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createFakeRawPhp } from "./helpers/fake-php.mjs";

// Swap the heavy collaborators (WASM loader, Omeka bootstrap) for test doubles
// controlled through globalThis.__cliStub. Only cli-runtime's own imports are
// redirected, so addons.js and spawn-handler.js stay real.
const stubs = {
  "./php-loader.js":
    "export const createPhpRuntime = (...a) => globalThis.__cliStub.createPhpRuntime(...a);",
  "./bootstrap.js":
    'export const OMEKA_ROOT = "/www/omeka"; export const prepareOmekaRuntimeFilesystem = (o) => globalThis.__cliStub.prepare(o);',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith("/src/runtime/cli-runtime.js") &&
      stubs[specifier]
    ) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { executeCliCommandInRuntime } = await import(
  "../src/runtime/cli-runtime.js"
);

// The real @php-wasm listFiles honors prependPath; cli-runtime walks with it.
function rawWithPrepend(files) {
  const raw = createFakeRawPhp({ files });
  raw.listFiles = (path, { prependPath } = {}) =>
    raw.FS.readdir(path)
      .filter((n) => n !== "." && n !== "..")
      .map((n) => (prependPath ? `${path}/${n}` : n));
  raw.rmdir = (path) => raw.FS.rmdir(path);
  return raw;
}

function wrap(raw) {
  return { _php: raw, binary: Promise.resolve({ FS: raw.FS }) };
}

describe("executeCliCommandInRuntime", () => {
  it("answers builtin commands without booting a runtime", async () => {
    globalThis.__cliStub = {
      createPhpRuntime: () => assert.fail("must not boot"),
    };
    const result = await executeCliCommandInRuntime({
      commandSpec: { kind: "builtin" },
      config: {},
      runtime: { phpVersion: "8.3" },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^PHP 8\.3/);
    assert.equal(result.stderr, "");
  });

  it("runs the script on a fresh runtime and syncs /persist both ways", async () => {
    const main = rawWithPrepend({
      "/persist/mutable/db/omeka.sqlite": "db-v1",
      "/persist/addons/modules/Foo/module.ini": "[info]",
    });
    main.FS.mkdirTree("/persist/empty");
    const cli = rawWithPrepend({ "/persist/stale.txt": "old" });
    let refreshed = false;
    let prepareArgs;
    let cliArgs;
    cli.cli = async (argv, options) => {
      cliArgs = { argv, options };
      // The CLI sees main's data and the stale file was removed.
      assert.equal(
        cli.readFileAsText("/persist/mutable/db/omeka.sqlite"),
        "db-v1",
      );
      assert.equal(cli.fileExists("/persist/stale.txt"), false);
      assert.equal(cli.isDir("/persist/empty"), true);
      cli.writeFile("/persist/mutable/db/omeka.sqlite", "db-v2");
      return {
        finished: Promise.resolve(),
        httpStatusCode: Promise.resolve(200),
        headers: Promise.resolve({}),
        stdoutBytes: Promise.resolve(new TextEncoder().encode("done\n")),
        stderrText: Promise.resolve("warn"),
        exitCode: Promise.resolve(3),
      };
    };
    let runtimeOptions;
    globalThis.__cliStub = {
      createPhpRuntime(runtime, options) {
        runtimeOptions = { runtime, options };
        return {
          async refresh() {
            refreshed = true;
          },
          ...wrap(cli),
        };
      },
      async prepare(options) {
        prepareArgs = options;
      },
    };

    const result = await executeCliCommandInRuntime({
      appBaseUrl: "https://app.test/",
      blueprint: { title: "bp" },
      commandSpec: {
        kind: "php",
        argv: ["php", "/www/omeka/application/data/scripts/perform-job.php"],
        scriptPath: "/www/omeka/application/data/scripts/perform-job.php",
      },
      config: { phpCorsProxyUrl: "https://proxy.test/" },
      mainPhp: wrap(main),
      runtime: { phpVersionLabel: "8.4" },
      runtimeId: "php84-omeka",
      spawnOptions: { env: { FOO: "1" }, cwd: "/tmp" },
    });

    assert.deepEqual(result, { stdout: "done\n", stderr: "warn", exitCode: 3 });
    assert.equal(refreshed, true);
    assert.deepEqual(runtimeOptions.options, {
      appBaseUrl: "https://app.test/",
      phpVersion: "8.4",
      phpCorsProxyUrl: "https://proxy.test/",
    });
    assert.equal(prepareArgs.runtimeId, "php84-omeka");
    assert.deepEqual(prepareArgs.blueprint, { title: "bp" });
    assert.deepEqual(cliArgs.argv, [
      "php",
      "/www/omeka/application/data/scripts/perform-job.php",
    ]);
    assert.deepEqual(cliArgs.options, {
      cwd: "/tmp",
      env: {
        FOO: "1",
        SCRIPT_PATH: "/www/omeka/application/data/scripts/perform-job.php",
        SHELL_PIPE: "0",
      },
    });
    // Writes made by the CLI flow back into the main runtime.
    assert.equal(
      main.readFileAsText("/persist/mutable/db/omeka.sqlite"),
      "db-v2",
    );
  });

  it("defaults cwd/env/proxy and tolerates an unreadable target tree", async () => {
    const main = rawWithPrepend({ "/persist/a.txt": "a" });
    const cli = rawWithPrepend({});
    // Existence checks that throw are treated as "nothing to remove".
    const realExists = cli.fileExists;
    let first = true;
    cli.fileExists = (path) => {
      if (first && path === "/persist") {
        first = false;
        throw new Error("io");
      }
      return realExists(path);
    };
    cli.isDir = (path) => {
      if (path === "/persist/broken") throw new Error("io");
      return (
        cli.FS.analyzePath(path).exists &&
        cli.FS.isDir(cli.FS.analyzePath(path).object.mode)
      );
    };
    cli.rmdir = () => {
      throw new Error("busy");
    };
    let options;
    cli.cli = async (_argv, opts) => {
      options = opts;
      cli.writeFile("/persist/broken", "x");
      return {
        finished: Promise.resolve(),
        httpStatusCode: Promise.resolve(200),
        headers: Promise.resolve({}),
        stdoutBytes: Promise.resolve(new Uint8Array()),
        stderrText: Promise.resolve(""),
        exitCode: Promise.resolve(0),
      };
    };
    const mainUnlink = main.unlink;
    main.unlink = (path) => {
      if (path === "/persist/a.txt") throw new Error("locked");
      return mainUnlink(path);
    };
    let runtimeOptions;
    globalThis.__cliStub = {
      createPhpRuntime(_runtime, opts) {
        runtimeOptions = opts;
        return { async refresh() {}, ...wrap(cli) };
      },
      async prepare() {},
    };
    const result = await executeCliCommandInRuntime({
      commandSpec: { kind: "php", argv: ["php", "-r", "1;"] },
      config: {},
      mainPhp: wrap(main),
      runtime: undefined,
    });
    assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 });
    assert.equal(runtimeOptions.phpCorsProxyUrl, null);
    assert.deepEqual(options, {
      cwd: "/www/omeka",
      env: { SCRIPT_PATH: "", SHELL_PIPE: "0" },
    });
    // The file the CLI wrote was copied back even though cleanup partly failed.
    assert.equal(main.readFileAsText("/persist/broken"), "x");
  });

  it("skips the copy when neither runtime has a /persist tree", async () => {
    const main = rawWithPrepend({});
    const cli = rawWithPrepend({});
    cli.cli = async () => ({
      finished: Promise.resolve(),
      httpStatusCode: Promise.resolve(200),
      headers: Promise.resolve({}),
      stdoutBytes: Promise.resolve(new TextEncoder().encode("ok")),
      stderrText: Promise.resolve(""),
      exitCode: Promise.resolve(0),
    });
    globalThis.__cliStub = {
      createPhpRuntime: () => ({ async refresh() {}, ...wrap(cli) }),
      async prepare() {},
    };
    const result = await executeCliCommandInRuntime({
      commandSpec: { kind: "php", argv: ["php", "-v"] },
      config: {},
      mainPhp: wrap(main),
    });
    assert.equal(result.stdout, "ok");
    assert.equal(main.fileExists("/persist"), false);
    assert.equal(cli.fileExists("/persist"), false);
  });
});
