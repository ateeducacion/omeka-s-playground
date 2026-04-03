import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSpawnProgram,
  getCliBuiltinCode,
  isAllowedPhpBinary,
  MAX_SPAWN_DEPTH,
  PHP_BIN_ALLOWLIST,
} from "../src/runtime/spawn-handler.js";

describe("isAllowedPhpBinary", () => {
  it("accepts 'php'", () => {
    assert.equal(isAllowedPhpBinary("php"), true);
  });

  it("accepts the playground PHP CLI path", () => {
    assert.equal(isAllowedPhpBinary("/playground/php-wasm/php"), true);
  });

  it("accepts /usr/bin/php", () => {
    assert.equal(isAllowedPhpBinary("/usr/bin/php"), true);
  });

  it("accepts /usr/local/bin/php", () => {
    assert.equal(isAllowedPhpBinary("/usr/local/bin/php"), true);
  });

  it("accepts any absolute path ending in /php", () => {
    assert.equal(isAllowedPhpBinary("/some/custom/path/php"), true);
  });

  it("rejects convert (ImageMagick)", () => {
    assert.equal(isAllowedPhpBinary("convert"), false);
  });

  it("rejects /usr/bin/convert", () => {
    assert.equal(isAllowedPhpBinary("/usr/bin/convert"), false);
  });

  it("rejects arbitrary binaries", () => {
    assert.equal(isAllowedPhpBinary("ls"), false);
    assert.equal(isAllowedPhpBinary("/bin/sh"), false);
    assert.equal(isAllowedPhpBinary("curl"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isAllowedPhpBinary(""), false);
  });

  it("rejects path containing php but not ending with /php", () => {
    assert.equal(isAllowedPhpBinary("/usr/bin/php-cgi"), false);
    assert.equal(isAllowedPhpBinary("/usr/bin/phpize"), false);
  });
});

describe("PHP_BIN_ALLOWLIST", () => {
  it("is a Set with expected entries", () => {
    assert.ok(PHP_BIN_ALLOWLIST instanceof Set);
    assert.ok(PHP_BIN_ALLOWLIST.has("php"));
    assert.ok(PHP_BIN_ALLOWLIST.has("/playground/php-wasm/php"));
  });
});

describe("MAX_SPAWN_DEPTH", () => {
  it("is a positive integer", () => {
    assert.equal(typeof MAX_SPAWN_DEPTH, "number");
    assert.ok(MAX_SPAWN_DEPTH > 0);
  });
});

describe("buildSpawnProgram", () => {
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

  it("rejects unknown commands with exit code 127", async () => {
    const mockPhp = {
      run: async () => ({ text: "", errors: "", exitCode: 0 }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["ls", "-la"], api, {});

    assert.equal(api.collected.exitCode, 127);
    assert.ok(api.collected.stderr.includes("Command not available"));
  });

  it("rejects convert (ImageMagick) with exit code 127", async () => {
    const mockPhp = {
      run: async () => ({ text: "", errors: "", exitCode: 0 }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["convert", "input.jpg", "output.png"], api, {});

    assert.equal(api.collected.exitCode, 127);
    assert.ok(api.collected.stderr.includes("Command not available"));
  });

  it("runs a PHP script via the mock PHP instance", async () => {
    const mockPhp = {
      run: async ({ scriptPath }) => ({
        text: `executed: ${scriptPath}`,
        errors: "",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "/path/to/script.php", "--flag"], api, {});

    assert.equal(api.collected.exitCode, 0);
    assert.ok(api.collected.stdout.includes("executed: /path/to/script.php"));
  });

  it("runs a PHP script via the playground PHP CLI path", async () => {
    const mockPhp = {
      run: async ({ scriptPath }) => ({
        text: `ran: ${scriptPath}`,
        errors: "",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(
      [
        "/playground/php-wasm/php",
        "/www/omeka/application/omeka",
        "jobs:dispatch",
      ],
      api,
      {},
    );

    assert.equal(api.collected.exitCode, 0);
    assert.ok(api.collected.stdout.includes("ran:"));
  });

  it("handles php -r inline code", async () => {
    const mockPhp = {
      run: async ({ code }) => ({
        text: code.includes("echo") ? "hello" : "",
        errors: "",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "-r", "echo 'hello';"], api, {});

    assert.equal(api.collected.exitCode, 0);
    assert.equal(api.collected.stdout, "hello");
  });

  it("handles php --version via CLI builtin emulation", async () => {
    const mockPhp = {
      run: async ({ code }) => ({
        text: code.includes("phpversion") ? "PHP 8.3.0 (cli) (php-wasm)\n" : "",
        errors: "",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "--version"], api, {});

    assert.equal(api.collected.exitCode, 0);
    assert.ok(api.collected.stdout.includes("PHP"));
  });

  it("handles php -v via CLI builtin emulation", async () => {
    const mockPhp = {
      run: async ({ code }) => ({
        text: code.includes("phpversion") ? "PHP 8.3.0 (cli) (php-wasm)\n" : "",
        errors: "",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["/playground/php-wasm/php", "-v"], api, {});

    assert.equal(api.collected.exitCode, 0);
    assert.ok(api.collected.stdout.includes("PHP"));
  });

  it("rejects commands without a script, -r flag, or builtin flag", async () => {
    const mockPhp = {
      run: async () => ({ text: "", errors: "", exitCode: 0 }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "--some-unknown-flag"], api, {});

    assert.equal(api.collected.exitCode, 1);
    assert.ok(api.collected.stderr.includes("No PHP script path found"));
  });

  it("propagates PHP execution errors", async () => {
    const mockPhp = {
      run: async () => {
        throw new Error("WASM memory error");
      },
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "/path/to/script.php"], api, {});

    assert.equal(api.collected.exitCode, 1);
    assert.ok(api.collected.stderr.includes("PHP execution error"));
    assert.ok(api.collected.stderr.includes("WASM memory error"));
  });

  it("propagates non-zero exit codes from PHP", async () => {
    const mockPhp = {
      run: async () => ({
        text: "some output",
        errors: "some error",
        exitCode: 42,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "/path/to/script.php"], api, {});

    assert.equal(api.collected.exitCode, 42);
    assert.equal(api.collected.stdout, "some output");
    assert.equal(api.collected.stderr, "some error");
  });

  it("captures stderr output from PHP", async () => {
    const mockPhp = {
      run: async () => ({
        text: "",
        errors: "Warning: something went wrong",
        exitCode: 0,
      }),
    };
    const program = buildSpawnProgram(mockPhp);
    const api = createMockProcessApi();

    await program(["php", "/path/to/script.php"], api, {});

    assert.equal(api.collected.exitCode, 0);
    assert.ok(api.collected.stderr.includes("Warning: something went wrong"));
  });
});

describe("getCliBuiltinCode", () => {
  it("returns PHP code for --version", () => {
    const code = getCliBuiltinCode(["--version"]);
    assert.ok(code);
    assert.ok(code.includes("phpversion"));
  });

  it("returns PHP code for -v", () => {
    const code = getCliBuiltinCode(["-v"]);
    assert.ok(code);
    assert.ok(code.includes("phpversion"));
  });

  it("returns null for unknown flags", () => {
    assert.equal(getCliBuiltinCode(["--help"]), null);
    assert.equal(getCliBuiltinCode(["--info"]), null);
  });

  it("returns null when multiple args are present", () => {
    assert.equal(getCliBuiltinCode(["--version", "--extra"]), null);
  });

  it("returns null for empty args", () => {
    assert.equal(getCliBuiltinCode([]), null);
  });
});
