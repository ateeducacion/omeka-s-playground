/**
 * Spawn handler for php-wasm proc_open/exec support.
 *
 * The active request runtime must never recursively execute CLI commands on
 * itself. Instead, this module parses and validates allowed commands, then
 * delegates execution to an isolated CLI runtime owned by php-worker.js.
 */

import { createSpawnHandler } from "@php-wasm/util";

const MAX_SPAWN_DEPTH = 3;

const PHP_BIN_ALLOWLIST = new Set([
  "php",
  "/playground/php-wasm/php",
  "/usr/bin/php",
  "/usr/local/bin/php",
]);

const CLI_BUILTIN_FLAGS = new Set(["--version", "-v"]);
const PHP_OPTIONS_WITH_VALUES = new Set(["-c", "--php-ini", "-d", "-z"]);
const PHP_STANDALONE_OPTIONS = new Set(["-n", "--no-php-ini"]);
const ALLOWED_SCRIPT_PATHS = new Set([
  "/www/omeka/application/data/scripts/perform-job.php",
  "/www/omeka/application/omeka",
  "/www/omeka/modules/EasyAdmin/data/scripts/task.php",
]);
const TRAILING_REDIRECTION_OPERATORS = new Set([
  ">",
  ">>",
  "<",
  "1>",
  "1>>",
  "2>",
  "2>>",
]);

function formatPhpVersionText(phpVersion) {
  return `PHP ${phpVersion || "unknown"} (cli) (php-wasm)\n`;
}

function isAllowedPhpBinary(bin) {
  if (typeof bin !== "string" || bin.length === 0) {
    return false;
  }

  if (PHP_BIN_ALLOWLIST.has(bin)) {
    return true;
  }
  return bin.endsWith("/php");
}

function isShellRedirectionToken(arg) {
  if (
    arg === "2>&1" ||
    arg === "1>&2" ||
    TRAILING_REDIRECTION_OPERATORS.has(arg)
  ) {
    return true;
  }

  return /^(?:[12]?>|[12]?>>|<).+/u.test(arg);
}

function stripTrailingShellTokens(args) {
  const normalized = [...args];
  let backgroundRequested = false;

  while (normalized.length > 0) {
    const lastArg = normalized.at(-1);
    if (lastArg === "&") {
      backgroundRequested = true;
      normalized.pop();
      continue;
    }

    if (lastArg === "2>&1" || lastArg === "1>&2") {
      normalized.pop();
      continue;
    }

    if (
      normalized.length >= 2 &&
      TRAILING_REDIRECTION_OPERATORS.has(normalized[normalized.length - 2])
    ) {
      normalized.pop();
      normalized.pop();
      continue;
    }

    if (isShellRedirectionToken(lastArg)) {
      normalized.pop();
      continue;
    }

    break;
  }

  return { args: normalized, backgroundRequested };
}

function parsePhpOptions(args) {
  const phpOptions = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (PHP_STANDALONE_OPTIONS.has(arg)) {
      phpOptions.push(arg);
      index += 1;
      continue;
    }

    if (PHP_OPTIONS_WITH_VALUES.has(arg)) {
      if (index + 1 >= args.length) {
        return { error: `Missing value for PHP option: ${arg}` };
      }
      phpOptions.push(arg, args[index + 1]);
      index += 2;
      continue;
    }

    break;
  }

  return {
    phpOptions,
    remainingArgs: args.slice(index),
  };
}

function buildBuiltinCommandSpec(
  bin,
  phpOptions,
  remainingArgs,
  backgroundRequested,
) {
  if (remainingArgs.length !== 1 || !CLI_BUILTIN_FLAGS.has(remainingArgs[0])) {
    return null;
  }

  return {
    kind: "builtin",
    bin,
    builtinFlag: remainingArgs[0],
    phpOptions,
    argv: [bin, ...phpOptions, remainingArgs[0]],
    backgroundRequested,
  };
}

function buildInlineCodeCommandSpec(
  bin,
  phpOptions,
  remainingArgs,
  backgroundRequested,
) {
  if (
    remainingArgs[0] !== "-r" ||
    !remainingArgs[1] ||
    remainingArgs.length !== 2
  ) {
    return null;
  }

  return {
    kind: "inline",
    bin,
    code: remainingArgs[1],
    phpOptions,
    argv: [bin, ...phpOptions, "-r", remainingArgs[1]],
    backgroundRequested,
  };
}

function buildScriptCommandSpec(
  bin,
  phpOptions,
  remainingArgs,
  backgroundRequested,
) {
  if (remainingArgs.length === 0) {
    return null;
  }

  const [scriptPath, ...scriptArgs] = remainingArgs;
  if (!ALLOWED_SCRIPT_PATHS.has(scriptPath)) {
    return null;
  }

  if (
    scriptPath === "/www/omeka/application/omeka" &&
    scriptArgs[0] !== "jobs:dispatch"
  ) {
    return null;
  }

  return {
    kind: "script",
    bin,
    scriptPath,
    scriptArgs,
    phpOptions,
    argv: [bin, ...phpOptions, scriptPath, ...scriptArgs],
    backgroundRequested,
  };
}

function parseSpawnCommand(command) {
  const [bin, ...rawArgs] = command;
  if (!isAllowedPhpBinary(bin)) {
    return {
      error: `Command not available in browser playground: ${bin || "<empty>"}`,
      exitCode: 127,
    };
  }

  const { args, backgroundRequested } = stripTrailingShellTokens(rawArgs);
  const parsedOptions = parsePhpOptions(args);
  if (parsedOptions.error) {
    return {
      error: parsedOptions.error,
      exitCode: 1,
    };
  }

  const { phpOptions, remainingArgs } = parsedOptions;
  const builtinSpec = buildBuiltinCommandSpec(
    bin,
    phpOptions,
    remainingArgs,
    backgroundRequested,
  );
  if (builtinSpec) {
    return { spec: builtinSpec };
  }

  const inlineSpec = buildInlineCodeCommandSpec(
    bin,
    phpOptions,
    remainingArgs,
    backgroundRequested,
  );
  if (inlineSpec) {
    return { spec: inlineSpec };
  }

  const scriptSpec = buildScriptCommandSpec(
    bin,
    phpOptions,
    remainingArgs,
    backgroundRequested,
  );
  if (scriptSpec) {
    return { spec: scriptSpec };
  }

  return {
    error: `Unsupported PHP CLI command in browser playground: ${command.join(" ")}`,
    exitCode: 1,
  };
}

async function writeProcessResult(processApi, result) {
  if (result.stdout) {
    processApi.stdout(result.stdout);
  }
  if (result.stderr) {
    processApi.stderr(result.stderr);
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
  processApi.exit(result.exitCode ?? 0);
}

function buildSpawnProgram(executeCliCommand) {
  let spawnDepth = 0;

  return async (command, processApi, options) => {
    const parsed = parseSpawnCommand(command);
    if (parsed.error) {
      processApi.stderr(`${parsed.error}\n`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      processApi.exit(parsed.exitCode ?? 1);
      return;
    }

    if (spawnDepth >= MAX_SPAWN_DEPTH) {
      processApi.stderr(
        `Spawn depth limit reached (${MAX_SPAWN_DEPTH}). Recursive proc_open calls are not supported.\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      processApi.exit(1);
      return;
    }

    spawnDepth += 1;
    try {
      const result = await executeCliCommand(parsed.spec, options || {});
      await writeProcessResult(processApi, result);
    } catch (error) {
      await writeProcessResult(processApi, {
        stderr: `PHP execution error: ${error.message}\n`,
        exitCode: 1,
      });
    } finally {
      spawnDepth -= 1;
    }
  };
}

export async function registerSpawnHandler(php, executeCliCommand) {
  const handler = createSpawnHandler(buildSpawnProgram(executeCliCommand));
  await php.setSpawnHandler(handler);
}

export {
  ALLOWED_SCRIPT_PATHS,
  buildSpawnProgram,
  CLI_BUILTIN_FLAGS,
  formatPhpVersionText,
  isAllowedPhpBinary,
  MAX_SPAWN_DEPTH,
  PHP_BIN_ALLOWLIST,
  PHP_OPTIONS_WITH_VALUES,
  PHP_STANDALONE_OPTIONS,
  parsePhpOptions,
  parseSpawnCommand,
  stripTrailingShellTokens,
};
