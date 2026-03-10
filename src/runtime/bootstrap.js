import { buildEffectivePlaygroundConfig, normalizeBlueprint } from "../shared/blueprint.js";
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

function phpBoolean(value) {
  return value ? "true" : "false";
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
    'installer' => [
        'tasks' => [
            Omeka\\Installation\\Task\\DestroySessionTask::class,
            Omeka\\Installation\\Task\\ClearCacheTask::class,
            Omeka\\Installation\\Task\\InstallSchemaTask::class,
            Omeka\\Installation\\Task\\RecordMigrationsTask::class,
            Omeka\\Installation\\Task\\CreateFirstUserTask::class,
            Omeka\\Installation\\Task\\AddDefaultSettingsTask::class,
        ],
    ],
    'logger' => [
        'log' => false,
    ],
    'assets' => [
        'use_externals' => false,
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

function buildInstallScript(config, manifestState, blueprint) {
  return `<?php
define('OMEKA_PATH', '${OMEKA_ROOT}');
chdir(OMEKA_PATH);
date_default_timezone_set('${config.timezone}');
require OMEKA_PATH . '/vendor/autoload.php';
$application = Omeka\\Mvc\\Application::init(require OMEKA_PATH . '/application/config/application.config.php');
$serviceManager = $application->getServiceManager();
$installer = new Omeka\\Installation\\Installer($serviceManager);
$apiManager = $serviceManager->get('Omeka\\\\ApiManager');
$entityManager = $serviceManager->get('Omeka\\\\EntityManager');
$auth = $serviceManager->get('Omeka\\\\AuthenticationService');
$settings = $serviceManager->get('Omeka\\\\Settings');
$themeManager = $serviceManager->get('Omeka\\\\Site\\\\ThemeManager');
$moduleManager = $serviceManager->get('Omeka\\\\ModuleManager');
$acl = $serviceManager->get('Omeka\\\\Acl');
$installer->registerPreTask(Omeka\\Installation\\Task\\CheckEnvironmentTask::class);
$installer->registerPreTask(Omeka\\Installation\\Task\\CheckDirPermissionsTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\DestroySessionTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\ClearCacheTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\InstallSchemaTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\RecordMigrationsTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\CreateFirstUserTask::class);
$installer->registerTask(Omeka\\Installation\\Task\\AddDefaultSettingsTask::class);
$status = $serviceManager->get('Omeka\\\\Status');
$blueprint = json_decode('${phpString(JSON.stringify(blueprint))}', true);

$statePath = '${PLAYGROUND_CONFIG_PATH}';
$state = [
  'manifest' => json_decode('${phpString(JSON.stringify(manifestState))}', true),
  'blueprint' => $blueprint,
  'installedAt' => gmdate('c'),
];

$warnings = [];

$findUserByEmail = function (string $email) use ($entityManager) {
  return $entityManager->getRepository(Omeka\\Entity\\User::class)->findOneBy(['email' => $email]);
};

$upsertUser = function (array $spec) use ($apiManager, $entityManager, &$warnings, $findUserByEmail) {
  $existing = $findUserByEmail($spec['email']);
  $payload = [
    'o:is_active' => array_key_exists('isActive', $spec) ? (bool) $spec['isActive'] : true,
    'o:role' => $spec['role'] ?? 'researcher',
    'o:name' => $spec['username'] ?? $spec['name'] ?? strtok($spec['email'], '@'),
    'o:email' => $spec['email'],
  ];

  if ($existing) {
    $apiManager->update('users', $existing->getId(), $payload, [], ['isPartial' => true]);
    $user = $entityManager->find(Omeka\\Entity\\User::class, $existing->getId());
  } else {
    $response = $apiManager->create('users', $payload);
    $userId = $response->getContent()->id();
    $user = $entityManager->find(Omeka\\Entity\\User::class, $userId);
  }

  if (!empty($spec['password'])) {
    $user->setPassword($spec['password']);
    $entityManager->flush();
  }

  return $user;
};

$ensureAdminIdentity = function (string $email) use ($auth, $findUserByEmail, $entityManager) {
  $admin = $findUserByEmail($email);
  if (!$admin) {
    $admin = $entityManager->getRepository(Omeka\\Entity\\User::class)->findOneBy(['role' => 'global_admin'], ['id' => 'ASC']);
  }
  if ($admin) {
    $auth->getStorage()->write($admin);
  }
  return $admin;
};

$normalizeModuleState = function (?string $state): string {
  $normalized = strtolower(trim((string) $state));
  return $normalized ?: 'activate';
};

$searchOne = function (string $resource, array $query) use ($apiManager) {
  $response = $apiManager->search($resource, $query + ['limit' => 1]);
  $content = $response->getContent();
  return $content ? reset($content) : null;
};

$debug = function (string $message) {
  echo "[debug] " . $message . PHP_EOL;
};

$propertyIdByTerm = function (string $term) use ($searchOne, &$warnings) {
  static $propertyMap = [];
  if (array_key_exists($term, $propertyMap)) {
    return $propertyMap[$term];
  }

  $property = $searchOne('properties', ['term' => $term]);
  if (!$property) {
    $warnings[] = sprintf('Property "%s" is not available in this Omeka installation.', $term);
    $propertyMap[$term] = null;
    return null;
  }

  $propertyMap[$term] = $property->id();
  return $propertyMap[$term];
};

$literalValues = function (?int $propertyId, ?string $value) {
  if (!$propertyId || $value === null || trim($value) === '') {
    return [];
  }

  return [[
    'property_id' => $propertyId,
    'type' => 'literal',
    '@value' => $value,
  ]];
};

$ensureCoreVocabulary = function () use ($searchOne, $propertyIdByTerm, $apiManager, &$warnings, $debug) {
  if ($propertyIdByTerm('dcterms:title')) {
    $debug('Dublin Core vocabulary already available.');
    return;
  }

  try {
    $existing = $searchOne('vocabularies', ['prefix' => 'dcterms']);
    if (!$existing) {
      $apiManager->create('vocabularies', [
        'o:namespace_uri' => 'http://purl.org/dc/terms/',
        'o:prefix' => 'dcterms',
        'o:label' => 'Dublin Core',
        'o:comment' => 'Basic resource metadata (DCMI Metadata Terms)',
        'o:property' => [
          [
            'o:local_name' => 'title',
            'o:label' => 'Title',
            'o:comment' => 'A name given to the resource.',
          ],
          [
            'o:local_name' => 'description',
            'o:label' => 'Description',
            'o:comment' => 'An account of the resource.',
          ],
          [
            'o:local_name' => 'creator',
            'o:label' => 'Creator',
            'o:comment' => 'An entity primarily responsible for making the resource.',
          ],
        ],
      ]);
      $debug('Created minimal Dublin Core vocabulary directly through the API.');
    } else {
      $debug('Dublin Core vocabulary already registered in Omeka.');
    }
  } catch (Throwable $e) {
    $warnings[] = sprintf('Unable to import the Dublin Core vocabulary automatically: %s', $e->getMessage());
  }
};

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
    echo implode(PHP_EOL, $installer->getErrors()) . PHP_EOL;
    exit(1);
  }
}

$ensureAdminIdentity('${config.admin.email}');

$users = $blueprint['users'] ?? [];
if (!$users) {
  $users = [[
    'username' => '${config.admin.username}',
    'email' => '${config.admin.email}',
    'password' => '${config.admin.password}',
    'role' => 'global_admin',
    'isActive' => true,
  ]];
}

foreach ($users as $userSpec) {
  $upsertUser($userSpec);
}

$primaryAdmin = $ensureAdminIdentity($users[0]['email'] ?? '${config.admin.email}');
if (!$primaryAdmin) {
  throw new RuntimeException('Unable to establish a global admin identity for blueprint provisioning.');
}

$settings->set('administrator_email', '${config.admin.email}');
$settings->set('installation_title', '${config.siteTitle}');
$settings->set('locale', '${config.locale}');
$settings->set('time_zone', '${config.timezone}');

foreach (($blueprint['modules'] ?? []) as $moduleSpec) {
  $moduleName = trim((string) ($moduleSpec['name'] ?? ''));
  if ($moduleName === '') {
    continue;
  }

  $module = $moduleManager->getModule($moduleName);
  if (!$module) {
    $warnings[] = sprintf('Module "%s" is not present in the bundled Omeka filesystem. Remote download is not implemented in-browser yet.', $moduleName);
    continue;
  }

  $state = $normalizeModuleState($moduleSpec['state'] ?? 'activate');
  $moduleState = $module->getState();

  if ($moduleState === Omeka\\Module\\Manager::STATE_NOT_INSTALLED && in_array($state, ['install', 'activate'], true)) {
    $moduleManager->install($module);
    continue;
  }

  if ($moduleState === Omeka\\Module\\Manager::STATE_NOT_ACTIVE && $state === 'activate') {
    $moduleManager->activate($module);
  }
}

$siteSpec = $blueprint['site'] ?? null;
$siteResource = null;
if (is_array($siteSpec) && !empty($siteSpec['title'])) {
  $themeName = trim((string) ($siteSpec['theme'] ?? 'default'));
  if (!$themeManager->getTheme($themeName)) {
    $warnings[] = sprintf('Theme "%s" is not present in the bundled Omeka filesystem. Falling back to "default".', $themeName);
    $themeName = 'default';
  }

  $siteRepo = $entityManager->getRepository(Omeka\\Entity\\Site::class);
  $site = $siteRepo->findOneBy(['slug' => $siteSpec['slug']]);
  $payload = [
    'o:title' => $siteSpec['title'],
    'o:slug' => $siteSpec['slug'],
    'o:theme' => $themeName,
    'o:is_public' => array_key_exists('isPublic', $siteSpec) ? (bool) $siteSpec['isPublic'] : true,
    'o:item_pool' => [],
  ];
  if (!empty($siteSpec['summary'])) {
    $payload['o:summary'] = $siteSpec['summary'];
  }

  if ($site) {
    $apiManager->update('sites', $site->getId(), $payload, [], ['isPartial' => true]);
    $siteResponse = $apiManager->read('sites', $site->getId());
  } else {
    $siteResponse = $apiManager->create('sites', $payload);
  }

  $siteResource = $siteResponse->getContent();
  if (!empty($siteSpec['setAsDefault'])) {
    $settings->set('default_site', $siteResource->id());
  }
}

$ensureCoreVocabulary();
$titlePropertyId = $propertyIdByTerm('dcterms:title');
$descriptionPropertyId = $propertyIdByTerm('dcterms:description');
$creatorPropertyId = $propertyIdByTerm('dcterms:creator');
$debug(sprintf(
  'Resolved property ids: title=%s description=%s creator=%s',
  json_encode($titlePropertyId),
  json_encode($descriptionPropertyId),
  json_encode($creatorPropertyId)
));

$itemSetIdsByTitle = [];
if ($titlePropertyId) {
foreach (($blueprint['itemSets'] ?? []) as $itemSetSpec) {
  if (empty($itemSetSpec['title'])) {
    continue;
  }

  $searchQuery = [
    'property' => [[
      'property' => $titlePropertyId,
      'type' => 'eq',
      'text' => $itemSetSpec['title'],
    ]],
  ];
  $existing = $titlePropertyId ? $searchOne('item_sets', $searchQuery) : null;
  $payload = [
    'dcterms:title' => $literalValues($titlePropertyId, $itemSetSpec['title']),
  ];
  if (!empty($itemSetSpec['description'])) {
    $payload['dcterms:description'] = $literalValues($descriptionPropertyId, $itemSetSpec['description']);
  }

  try {
    if ($existing) {
      $apiManager->update('item_sets', $existing->id(), $payload);
      $itemSetIdsByTitle[$itemSetSpec['title']] = $existing->id();
      $debug(sprintf('Updated item set "%s" (#%s).', $itemSetSpec['title'], $existing->id()));
    } else {
      $response = $apiManager->create('item_sets', $payload);
      $itemSetIdsByTitle[$itemSetSpec['title']] = $response->getContent()->id();
      $debug(sprintf('Created item set "%s" (#%s).', $itemSetSpec['title'], $response->getContent()->id()));
    }
  } catch (Throwable $e) {
    $warnings[] = sprintf('Unable to provision item set "%s": %s', $itemSetSpec['title'], $e->getMessage());
  }
}

foreach (($blueprint['items'] ?? []) as $itemSpec) {
  if (empty($itemSpec['title'])) {
    continue;
  }

  $searchQuery = [
    'property' => [[
      'property' => $titlePropertyId,
      'type' => 'eq',
      'text' => $itemSpec['title'],
    ]],
  ];
  $existing = $titlePropertyId ? $searchOne('items', $searchQuery) : null;
  $payload = [
    'dcterms:title' => $literalValues($titlePropertyId, $itemSpec['title']),
  ];

  if (!empty($itemSpec['description'])) {
    $payload['dcterms:description'] = $literalValues($descriptionPropertyId, $itemSpec['description']);
  }

  if (!empty($itemSpec['creator'])) {
    $payload['dcterms:creator'] = $literalValues($creatorPropertyId, $itemSpec['creator']);
  }

  $itemSetIds = [];
  foreach (($itemSpec['itemSets'] ?? []) as $itemSetTitle) {
    if (isset($itemSetIdsByTitle[$itemSetTitle])) {
      $itemSetIds[] = ['o:id' => $itemSetIdsByTitle[$itemSetTitle]];
    }
  }
  if ($itemSetIds) {
    $payload['o:item_set'] = $itemSetIds;
  }

  if ($siteResource) {
    $payload['o:site'] = [['o:id' => $siteResource->id()]];
  }

  $payload['o:media'] = [];
  foreach (($itemSpec['media'] ?? []) as $mediaSpec) {
    if (($mediaSpec['type'] ?? 'url') !== 'url' || empty($mediaSpec['url'])) {
      continue;
    }

    $mediaPayload = [
      'o:ingester' => 'url',
      'ingest_url' => $mediaSpec['url'],
      'o:source' => $mediaSpec['url'],
    ];
    if (!empty($mediaSpec['title'])) {
      $mediaPayload['dcterms:title'] = $literalValues($titlePropertyId, $mediaSpec['title']);
    }
    if (!empty($mediaSpec['altText'])) {
      $mediaPayload['o:alt_text'] = $mediaSpec['altText'];
    }
    $payload['o:media'][] = $mediaPayload;
  }

  try {
    if ($existing) {
      $apiManager->update('items', $existing->id(), $payload);
      $debug(sprintf('Updated item "%s" (#%s).', $itemSpec['title'], $existing->id()));
    } else {
      $response = $apiManager->create('items', $payload);
      $debug(sprintf('Created item "%s" (#%s).', $itemSpec['title'], $response->getContent()->id()));
    }
  } catch (Throwable $e) {
    $warnings[] = sprintf('Unable to provision item "%s": %s', $itemSpec['title'], $e->getMessage());
  }
}
} elseif (($blueprint['itemSets'] ?? []) || ($blueprint['items'] ?? [])) {
  $warnings[] = 'Blueprint content provisioning was skipped because dcterms:title is not available in this runtime.';
}

file_put_contents($statePath, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
echo "omeka-playground-bootstrap-complete\\n";
foreach ($warnings as $warning) {
  echo "[warning] " . $warning . "\\n";
}
`;
}

function buildProbeScript() {
  return `<?php
$result = [
  'php_ini_loaded_file' => php_ini_loaded_file(),
  'pdo_loaded' => extension_loaded('PDO'),
  'sqlite_loaded' => extension_loaded('sqlite3'),
  'pdo_sqlite_loaded' => extension_loaded('pdo_sqlite'),
  'available_drivers' => class_exists('PDO') ? PDO::getAvailableDrivers() : [],
  'php_ini' => @file_get_contents('/php.ini'),
];

header('Content-Type: application/json');
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
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

export async function bootstrapOmeka({ blueprint, config, php, publish, runtimeId }) {
  const normalizedBlueprint = normalizeBlueprint(blueprint, config);
  const effectiveConfig = buildEffectivePlaygroundConfig(config, normalizedBlueprint);

  publish("Preparing PHP filesystem layout.", 0.2);
  await ensureMutableLayout(php);

  publish("Loading Omeka readonly bundle manifest.", 0.28);
  const manifest = await fetchManifest();
  const manifestState = buildManifestState(manifest, runtimeId, effectiveConfig.bundleVersion);
  const savedState = await readJson(php, PLAYGROUND_CONFIG_PATH);

  if (
    effectiveConfig.resetOnVersionMismatch
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
  await php.writeFile(`${OMEKA_ROOT}/config/local.config.php`, encoder.encode(buildLocalConfig(effectiveConfig)));
  await appendPhpIniOverrides(php, effectiveConfig);
  await php.writeFile(`${OMEKA_ROOT}/playground-probe.php`, encoder.encode(buildProbeScript()));

  const probeResponse = await php.request(new Request("https://playground.internal/playground-probe.php"));
  const probeText = await probeResponse.text();
  const probe = JSON.parse(probeText);

  if (!probe.available_drivers?.includes("sqlite")) {
    throw new Error(`SQLite probe failed: ${probeText}`);
  }

  publish("Running automatic Omeka installer if needed.", 0.64);
  await php.writeFile(`${OMEKA_ROOT}/playground-install.php`, encoder.encode(buildInstallScript(effectiveConfig, manifestState, normalizedBlueprint)));
  const output = await php.request(new Request("https://playground.internal/playground-install.php"));

  const outputText = await output.text();
  const outputLines = outputText
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of outputLines) {
    if (line === "omeka-playground-bootstrap-complete") {
      continue;
    }

    if (line.startsWith("[debug]")) {
      publish(line, 0.78);
      continue;
    }

    if (line.startsWith("[warning]")) {
      publish(line, 0.82);
      continue;
    }

    publish(`Installer output: ${line}`, 0.74);
  }

  if (!outputText.includes("omeka-playground-bootstrap-complete")) {
    throw new Error(`Unexpected Omeka bootstrap output: ${outputText}`);
  }

  publish("Bootstrap complete. Omeka is ready.", 0.96);

  return {
    manifest,
    manifestState,
  };
}
