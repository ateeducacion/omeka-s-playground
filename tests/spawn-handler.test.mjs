import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALLOWED_SCRIPT_PATHS,
  buildSpawnProgram,
  isAllowedPhpBinary,
  MAX_SPAWN_DEPTH,
  PHP_BIN_ALLOWLIST,
  parseSpawnCommand,
  stripTrailingShellTokens,
} from "../src/runtime/spawn-handler.js";

function createMockProcessApi() {
  const collected = { stdout: "", stderr: "", exitCode: null };
  return {
    collected,
    stdout(data) {
      collected.stdout += typeof data === "string" ? data : String(data);
    },
    stderr(data) {
      collected.stderr += typeof data === "string" ? data : String(data);
    },
    exit(code) {
      collected.exitCode = code;
    },
    on() {},
  };
}

describe("isAllowedPhpBinary", () => {
  it("accepts the supported PHP binaries", () => {
    assert.equal(isAllowedPhpBinary("php"), true);
    assert.equal(isAllowedPhpBinary("/playground/php-wasm/php"), true);
    assert.equal(isAllowedPhpBinary("/usr/bin/php"), true);
    assert.equal(isAllowedPhpBinary("/custom/php"), true);
  });

  it("rejects unsupported binaries", () => {
    assert.equal(isAllowedPhpBinary("convert"), false);
    assert.equal(isAllowedPhpBinary("/usr/bin/convert"), false);
    assert.equal(isAllowedPhpBinary(""), false);
    assert.equal(isAllowedPhpBinary(undefined), false);
  });
});

describe("exported constants", () => {
  it("exports the allowlists used by the parser", () => {
    assert.ok(PHP_BIN_ALLOWLIST instanceof Set);
    assert.ok(ALLOWED_SCRIPT_PATHS instanceof Set);
    assert.equal(typeof MAX_SPAWN_DEPTH, "number");
    assert.ok(MAX_SPAWN_DEPTH > 0);
  });
});

describe("stripTrailingShellTokens", () => {
  it("removes trailing redirections and background operators", () => {
    assert.deepEqual(
      stripTrailingShellTokens([
        "/www/omeka/application/data/scripts/perform-job.php",
        "--job-id",
        "1",
        ">",
        "/dev/null",
        "2>&1",
        "&",
      ]),
      {
        args: [
          "/www/omeka/application/data/scripts/perform-job.php",
          "--job-id",
          "1",
        ],
        backgroundRequested: true,
      },
    );
  });

  it("keeps normal argv intact", () => {
    assert.deepEqual(stripTrailingShellTokens(["--task", "LoopItems"]), {
      args: ["--task", "LoopItems"],
      backgroundRequested: false,
    });
  });
});

describe("parseSpawnCommand", () => {
  it("parses php --version with PHP options and shell suffixes", () => {
    const parsed = parseSpawnCommand([
      "php",
      "-d",
      "memory_limit=256M",
      "--version",
      "2>&1",
      "&",
    ]);

    assert.deepEqual(parsed.spec, {
      kind: "builtin",
      bin: "php",
      builtinFlag: "--version",
      phpOptions: ["-d", "memory_limit=256M"],
      argv: ["php", "-d", "memory_limit=256M", "--version"],
      backgroundRequested: true,
    });
  });

  it("parses inline code commands", () => {
    const parsed = parseSpawnCommand(["php", "-r", "echo 'hi';", "2>&1"]);

    assert.deepEqual(parsed.spec, {
      kind: "inline",
      bin: "php",
      code: "echo 'hi';",
      phpOptions: [],
      argv: ["php", "-r", "echo 'hi';"],
      backgroundRequested: false,
    });
  });

  it("parses Omeka job commands and strips shell sugar", () => {
    const parsed = parseSpawnCommand([
      "/playground/php-wasm/php",
      "/www/omeka/application/data/scripts/perform-job.php",
      "--job-id",
      "12",
      "--base-path",
      "/",
      "--server-url",
      "http://127.0.0.1:8080",
      ">",
      "/dev/null",
      "2>&1",
      "&",
    ]);

    assert.deepEqual(parsed.spec, {
      kind: "script",
      bin: "/playground/php-wasm/php",
      scriptPath: "/www/omeka/application/data/scripts/perform-job.php",
      scriptArgs: [
        "--job-id",
        "12",
        "--base-path",
        "/",
        "--server-url",
        "http://127.0.0.1:8080",
      ],
      phpOptions: [],
      argv: [
        "/playground/php-wasm/php",
        "/www/omeka/application/data/scripts/perform-job.php",
        "--job-id",
        "12",
        "--base-path",
        "/",
        "--server-url",
        "http://127.0.0.1:8080",
      ],
      backgroundRequested: true,
    });
  });

  it("allows EasyAdmin task entrypoint", () => {
    const parsed = parseSpawnCommand([
      "php",
      "/www/omeka/modules/EasyAdmin/data/scripts/task.php",
      "--task",
      "LoopItems",
    ]);

    assert.equal(parsed.spec?.kind, "script");
    assert.equal(
      parsed.spec?.scriptPath,
      "/www/omeka/modules/EasyAdmin/data/scripts/task.php",
    );
  });

  it("rejects unsupported binaries", () => {
    const parsed = parseSpawnCommand(["convert", "input.jpg"]);

    assert.equal(parsed.exitCode, 127);
    assert.match(parsed.error, /Command not available/u);
  });

  it("rejects arbitrary PHP scripts", () => {
    const parsed = parseSpawnCommand(["php", "/tmp/test.php"]);

    assert.equal(parsed.exitCode, 1);
    assert.match(parsed.error, /Unsupported PHP CLI command/u);
  });

  it("rejects unsupported Omeka console commands", () => {
    const parsed = parseSpawnCommand([
      "php",
      "/www/omeka/application/omeka",
      "cache:clear",
    ]);

    assert.equal(parsed.exitCode, 1);
    assert.match(parsed.error, /Unsupported PHP CLI command/u);
  });
});

describe("buildSpawnProgram", () => {
  it("delegates parsed commands and forwards process options", async () => {
    let receivedSpec = null;
    let receivedOptions = null;
    const program = buildSpawnProgram(async (spec, options) => {
      receivedSpec = spec;
      receivedOptions = options;
      return {
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      };
    });
    const api = createMockProcessApi();

    await program(
      ["php", "/www/omeka/application/omeka", "jobs:dispatch", "2>&1"],
      api,
      { cwd: "/www/omeka", env: { TEST: "1" } },
    );

    assert.equal(api.collected.exitCode, 0);
    assert.equal(api.collected.stdout, "ok");
    assert.equal(receivedSpec.scriptPath, "/www/omeka/application/omeka");
    assert.deepEqual(receivedOptions, {
      cwd: "/www/omeka",
      env: { TEST: "1" },
    });
  });

  it("writes parser errors to stderr", async () => {
    const program = buildSpawnProgram(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const api = createMockProcessApi();

    await program(["php", "/tmp/nope.php"], api, {});

    assert.equal(api.collected.exitCode, 1);
    assert.match(api.collected.stderr, /Unsupported PHP CLI command/u);
  });

  it("writes executor failures to stderr", async () => {
    const program = buildSpawnProgram(async () => {
      throw new Error("boom");
    });
    const api = createMockProcessApi();

    await program(["php", "--version"], api, {});

    assert.equal(api.collected.exitCode, 1);
    assert.match(api.collected.stderr, /PHP execution error: boom/u);
  });
});
