import { PHPResponse } from "@php-wasm/universal";
import { mountPersistedAddons } from "./addons.js";
import { OMEKA_ROOT, prepareOmekaRuntimeFilesystem } from "./bootstrap.js";
import { createPhpRuntime } from "./php-loader.js";
import { formatPhpVersionText } from "./spawn-handler.js";

function isDirectory(rawPhp, path) {
  try {
    return rawPhp.isDir(path);
  } catch {
    return false;
  }
}

function removeTree(rawPhp, path) {
  try {
    if (!rawPhp.fileExists(path)) {
      return;
    }
  } catch {
    return;
  }

  if (isDirectory(rawPhp, path)) {
    for (const entry of rawPhp.listFiles(path, { prependPath: true })) {
      removeTree(rawPhp, entry);
    }
    try {
      rawPhp.rmdir(path);
    } catch {
      // Best effort cleanup only.
    }
    return;
  }

  try {
    rawPhp.unlink(path);
  } catch {
    // Best effort cleanup only.
  }
}

function copyTree(
  rawPhpSource,
  rawPhpTarget,
  path,
  { resetTarget = false } = {},
) {
  if (resetTarget) {
    removeTree(rawPhpTarget, path);
  }

  if (!rawPhpSource.fileExists(path)) {
    return;
  }

  if (isDirectory(rawPhpSource, path)) {
    rawPhpTarget.mkdirTree(path);
    for (const entry of rawPhpSource.listFiles(path, { prependPath: true })) {
      copyTree(rawPhpSource, rawPhpTarget, entry);
    }
    return;
  }

  const lastSlash = path.lastIndexOf("/");
  if (lastSlash > 0) {
    rawPhpTarget.mkdirTree(path.slice(0, lastSlash));
  }
  rawPhpTarget.writeFile(path, rawPhpSource.readFileAsBuffer(path));
}

function captureBuiltinOutput(_commandSpec, phpVersion) {
  return {
    stdout: formatPhpVersionText(phpVersion),
    stderr: "",
    exitCode: 0,
  };
}

function buildCliArgv(commandSpec) {
  return [...commandSpec.argv];
}

export async function executeCliCommandInRuntime({
  appBaseUrl,
  blueprint,
  commandSpec,
  config,
  mainPhp,
  runtime,
  runtimeId,
  spawnOptions = {},
}) {
  if (commandSpec.kind === "builtin") {
    return captureBuiltinOutput(
      commandSpec,
      runtime?.phpVersion || runtime?.phpVersionLabel,
    );
  }

  const cliPhp = createPhpRuntime(runtime, {
    appBaseUrl,
    phpVersion: runtime?.phpVersion || runtime?.phpVersionLabel,
    phpCorsProxyUrl: config.phpCorsProxyUrl || null,
  });

  await cliPhp.refresh();

  const mainRawPhp = mainPhp._php;
  const cliRawPhp = cliPhp._php;

  await prepareOmekaRuntimeFilesystem({
    blueprint,
    config,
    php: cliPhp,
    runtimeId,
  });

  copyTree(mainRawPhp, cliRawPhp, "/persist", { resetTarget: true });
  await mountPersistedAddons({ php: cliPhp, omekaRoot: OMEKA_ROOT });

  const streamed = await cliRawPhp.cli(buildCliArgv(commandSpec), {
    cwd: spawnOptions.cwd || OMEKA_ROOT,
    env: {
      ...(spawnOptions.env || {}),
      SCRIPT_PATH: commandSpec.scriptPath || "",
      SHELL_PIPE: "0",
    },
  });
  const response = await PHPResponse.fromStreamedResponse(streamed);

  copyTree(cliRawPhp, mainRawPhp, "/persist", { resetTarget: true });
  await mountPersistedAddons({ php: mainPhp, omekaRoot: OMEKA_ROOT });

  return {
    stdout: response.text || "",
    stderr: response.errors || "",
    exitCode: response.exitCode ?? 0,
  };
}
