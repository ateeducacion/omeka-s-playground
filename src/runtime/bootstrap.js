import { fetchManifest, buildManifestState } from "./manifest.js";
import { mountReadonlyCore } from "./vfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PLAYGROUND_DB_PATH = "/persist/mutable/db/omeka.sqlite";
export const PLAYGROUND_CONFIG_PATH = "/persist/mutable/config/playground-state.json";
export const OMEKA_ROOT = "/persist/www/omeka";

function phpString(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
}

function buildDatabaseIni() {
  return [
    'driver = "pdo_sqlite"',
    `path = "${PLAYGROUND_DB_PATH}"`,
    "",
  ].join("\n");
}

function buildLocalConfig(config) {
  return `<?php
return [
    'logger' => [
        'log' => false,
    ],
    'translator' => [
        'locale' => '${config.locale}',
    ],
    'thumbnails' => [
        'types' => [
            'large' => ['constraint' => 800],
            'medium' => ['constraint' => 400],
            'square' => ['constraint' => 400],
        ],
    ],
];
`;
}

function buildInstallScript(config, manifestState) {
  return `<?php
define('OMEKA_PATH', '${OMEKA_ROOT}');
chdir(OMEKA_PATH);
date_default_timezone_set('${config.timezone}');
require OMEKA_PATH . '/vendor/autoload.php';
$application = Omeka\\Mvc\\Application::init(require OMEKA_PATH . '/application/config/application.config.php');
$serviceManager = $application->getServiceManager();
$installer = $serviceManager->get('Omeka\\\\Installer');
$status = $serviceManager->get('Omeka\\\\Status');

$statePath = '${PLAYGROUND_CONFIG_PATH}';
$state = [
  'manifest' => json_decode('${phpString(JSON.stringify(manifestState))}', true),
  'installedAt' => gmdate('c'),
];

if (!$status->isInstalled()) {
  $installer->registerVars('Omeka\\\\Installation\\\\Task\\\\CreateFirstUserTask', [
    'name' => '${config.admin.username}',
    'email' => '${config.admin.email}',
    'password-confirm' => [
      'password' => '${config.admin.password}',
    ],
  ]);

  $installer->registerVars('Omeka\\\\Installation\\\\Task\\\\AddDefaultSettingsTask', [
    'administrator_email' => '${config.admin.email}',
    'installation_title' => '${config.siteTitle}',
    'time_zone' => '${config.timezone}',
    'locale' => '${config.locale}',
  ]);

  if (!$installer->install()) {
    fwrite(STDERR, implode(PHP_EOL, $installer->getErrors()) . PHP_EOL);
    exit(1);
  }
}

file_put_contents($statePath, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
echo "omeka-playground-bootstrap-complete\\n";
`;
}

function buildPhpIni(config) {
  return [
    "display_errors=1",
    "display_startup_errors=1",
    "error_reporting=E_ALL",
    "memory_limit=512M",
    "max_execution_time=30",
    `date.timezone=${config.timezone}`,
    "session.save_path=/persist/mutable/session",
    "",
  ].join("\n");
}

async function ensureDir(php, path) {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    const about = await php.analyzePath(current);
    if (!about?.exists) {
      try {
        await php.mkdir(current);
      } catch {
        // Ignore races between workers/requests.
      }
    }
  }
}

async function ensureMutableLayout(php) {
  for (const path of [
    "/persist",
    "/persist/mutable",
    "/persist/mutable/config",
    "/persist/mutable/db",
    "/persist/mutable/files",
    "/persist/mutable/logs",
    "/persist/mutable/session",
    "/persist/runtime",
    "/persist/www",
  ]) {
    await ensureDir(php, path);
  }
}

async function safeUnlink(php, path) {
  const about = await php.analyzePath(path);
  if (!about?.exists) {
    return;
  }

  await php.unlink(path);
}

async function readJson(php, path) {
  const about = await php.analyzePath(path);
  if (!about?.exists) {
    return null;
  }

  const raw = await php.readFile(path);
  return JSON.parse(decoder.decode(raw));
}

async function appendPhpIniOverrides(php, config) {
  const about = await php.analyzePath("/php.ini");
  const existing = about?.exists
    ? decoder.decode(await php.readFile("/php.ini"))
    : "";

  const merged = `${existing.replace(/\s*$/u, "\n")}${buildPhpIni(config)}`;
  await php.writeFile("/php.ini", encoder.encode(merged));
}

export async function bootstrapOmeka({ config, php, publish, runtimeId }) {
  publish("Preparing PHP filesystem layout.", 0.2);
  await ensureMutableLayout(php);

  publish("Loading Omeka readonly bundle manifest.", 0.28);
  const manifest = await fetchManifest();
  const manifestState = buildManifestState(manifest, runtimeId, config.bundleVersion);
  const savedState = await readJson(php, PLAYGROUND_CONFIG_PATH);

  if (
    config.resetOnVersionMismatch
    && savedState?.manifest
    && JSON.stringify(savedState.manifest) !== JSON.stringify(manifestState)
  ) {
    publish("Bundle version changed. Resetting mutable files.", 0.34);
    await safeUnlink(php, PLAYGROUND_DB_PATH);
    await safeUnlink(php, PLAYGROUND_CONFIG_PATH);
  }

  publish("Mounting readonly Omeka core bundle.", 0.4);
  await mountReadonlyCore(php, manifest);

  publish("Writing SQLite and local config overrides.", 0.48);
  await php.writeFile(`${OMEKA_ROOT}/config/database.ini`, encoder.encode(buildDatabaseIni()));
  await php.writeFile(`${OMEKA_ROOT}/config/local.config.php`, encoder.encode(buildLocalConfig(config)));
  await appendPhpIniOverrides(php, config);

  publish("Running automatic Omeka installer if needed.", 0.64);
  await php.writeFile(`${OMEKA_ROOT}/playground-install.php`, encoder.encode(buildInstallScript(config, manifestState)));
  const output = await php.request(new Request("https://playground.internal/playground-install.php"));

  const outputText = await output.text();

  if (!outputText.includes("omeka-playground-bootstrap-complete")) {
    throw new Error(`Unexpected Omeka bootstrap output: ${outputText}`);
  }

  publish("Bootstrap complete. Omeka is ready.", 0.96);

  return {
    manifest,
    manifestState,
  };
}
