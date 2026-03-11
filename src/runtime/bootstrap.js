import { buildEffectivePlaygroundConfig, normalizeBlueprint } from "../shared/blueprint.js";
import { materializeBlueprintAddons } from "./addons.js";
import { fetchManifest, buildManifestState } from "./manifest.js";
import { mountReadonlyCore } from "./vfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PLAYGROUND_DB_PATH = "/persist/mutable/db/omeka.sqlite";
export const PLAYGROUND_CONFIG_PATH = "/persist/mutable/config/playground-state.json";
export const PLAYGROUND_PREPEND_PATH = "/persist/mutable/config/playground-prepend.php";
export const OMEKA_ROOT = "/www/omeka";
export const OMEKA_FILES_PATH = "/persist/mutable/files";
export const PLAYGROUND_BLUEPRINT_MEDIA_PATH = "/persist/runtime/blueprint-media";

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
  const debugEnabled = config.debug?.enabled === true;

  return `<?php
$thumbnailerAlias = extension_loaded('gd')
    ? 'Omeka\\\\File\\\\Thumbnailer\\\\Gd'
    : 'Omeka\\\\File\\\\Thumbnailer\\\\NoThumbnail';

$browserPhpCliPath = '/playground/php-wasm/php';
$browserImageMagickPath = '/playground/unavailable/convert';
$browserImageMagickDir = dirname($browserImageMagickPath);

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
        'log' => ${phpBoolean(debugEnabled)},
        'priority' => ${debugEnabled ? "\\Laminas\\Log\\Logger::DEBUG" : "\\Laminas\\Log\\Logger::NOTICE"},
    ],
    'view_manager' => [
        'display_not_found_reason' => ${phpBoolean(debugEnabled)},
        'display_exceptions' => true,
    ],
    'assets' => [
        'use_externals' => false,
    ],
    'cli' => [
        'phpcli_path' => $browserPhpCliPath,
    ],
    'file_store' => [
        'local' => [
            'base_path' => '${OMEKA_FILES_PATH}',
        ],
    ],
    'translator' => [
        'locale' => '${config.locale}',
    ],
    'entity_manager' => [
        'is_dev_mode' => ${phpBoolean(debugEnabled)},
    ],
    'thumbnails' => [
        'types' => [
            'large' => ['constraint' => 800],
            'medium' => ['constraint' => 400],
            'square' => ['constraint' => 400],
        ],
        'thumbnailer_options' => [
            'imagemagick_dir' => $browserImageMagickDir,
        ],
    ],
    'service_manager' => [
        'factories' => [
            'Omeka\\Cli' => function ($services) use ($browserPhpCliPath, $browserImageMagickPath) {
                $logger = $services->get('Omeka\\\\Logger');
                return new class ($logger, $browserPhpCliPath, $browserImageMagickPath) extends \\Omeka\\Stdlib\\Cli {
                    private $browserPhpCliPath;
                    private $browserImageMagickPath;

                    public function __construct($logger, $browserPhpCliPath, $browserImageMagickPath)
                    {
                        parent::__construct($logger, 'exec');
                        $this->browserPhpCliPath = $browserPhpCliPath;
                        $this->browserImageMagickPath = $browserImageMagickPath;
                    }

                    public function getCommandPath($command)
                    {
                        if ($command === 'php') {
                            return $this->browserPhpCliPath;
                        }
                        if ($command === 'convert') {
                            return $this->browserImageMagickPath;
                        }
                        return false;
                    }

                    public function validateCommand($commandDir, $command = null)
                    {
                        $commandPath = $command === null ? (string) $commandDir : sprintf('%s/%s', rtrim((string) $commandDir, '/'), $command);
                        if ($commandPath === $this->browserPhpCliPath || $commandPath === $this->browserImageMagickPath) {
                            return $commandPath;
                        }
                        return false;
                    }

                    public function execute($command)
                    {
                        $command = (string) $command;
                        if (str_contains($command, $this->browserPhpCliPath)) {
                            return 'PHP CLI is not available in the browser playground. Omeka background jobs run synchronously in this runtime.';
                        }
                        if (str_contains($command, $this->browserImageMagickPath)) {
                            return 'ImageMagick is not available in the browser playground. Thumbnail generation uses GD when available and otherwise falls back to no thumbnails.';
                        }
                        return false;
                    }
                };
            },
        ],
        'aliases' => [
            'Omeka\\File\\Thumbnailer' => $thumbnailerAlias,
            'Omeka\\Job\\DispatchStrategy' => 'Omeka\\Job\\DispatchStrategy\\Synchronous',
        ],
    ],
    'media_ingesters' => [
        'factories' => [
            'playground_cached_file' => function ($services) {
                $tempFileFactory = $services->get('Omeka\\\\File\\\\TempFileFactory');
                return new class ($tempFileFactory) implements \\Omeka\\Media\\Ingester\\IngesterInterface {
                    private $tempFileFactory;

                    public function __construct($tempFileFactory)
                    {
                        $this->tempFileFactory = $tempFileFactory;
                    }

                    public function getLabel()
                    {
                        return 'Playground cached file';
                    }

                    public function getRenderer()
                    {
                        return 'file';
                    }

                    public function ingest(\\Omeka\\Entity\\Media $media, \\Omeka\\Api\\Request $request, \\Omeka\\Stdlib\\ErrorStore $errorStore)
                    {
                        $data = $request->getContent();
                        $cachedPath = isset($data['playground_cached_path']) ? (string) $data['playground_cached_path'] : '';
                        if ($cachedPath === '' || !is_readable($cachedPath)) {
                            $errorStore->addError('playground_cached_path', 'No readable cached file was prepared for this media.');
                            return;
                        }

                        $tempFile = $this->tempFileFactory->build();

                        try {
                            if (!@copy($cachedPath, $tempFile->getTempPath())) {
                                $errorStore->addError('playground_cached_path', sprintf('Unable to copy cached file "%s" into Omeka temp storage.', $cachedPath));
                                return;
                            }

                            $sourceName = isset($data['playground_cached_name']) && $data['playground_cached_name'] !== ''
                                ? (string) $data['playground_cached_name']
                                : basename($cachedPath);

                            $tempFile->setSourceName($sourceName);
                            if (!array_key_exists('o:source', $data)) {
                                $media->setSource($sourceName);
                            }

                            $tempFile->mediaIngestFile($media, $request, $errorStore);
                        } finally {
                            $tempFile->delete();
                        }
                    }

                    public function form(\\Laminas\\View\\Renderer\\PhpRenderer $view, array $options = [])
                    {
                        return '';
                    }
                };
            },
        ],
    ],
];
`;
}

function buildPhpPrepend(config) {
  const debugBlock = config.debug?.enabled === true
    ? `
// Enable a development-like Omeka/PHP mode when requested by the blueprint.
putenv('APPLICATION_ENV=development');
putenv('OMEKA_REPORT_DEPRECATED=1');
$_SERVER['APPLICATION_ENV'] = 'development';
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');
error_reporting(E_ALL);
`
    : "";

  return `<?php
// Generated by Omeka S Playground.
// This prepend file carries runtime shims needed by the php-wasm environment.

if (!defined('FILEINFO_MIME_TYPE')) {
    define('FILEINFO_MIME_TYPE', 16);
}

if (!class_exists('finfo')) {
    // php-wasm builds used by the playground may not ship ext-fileinfo.
    // Omeka needs finfo only to resolve upload media types, so a small
    // compatibility shim is enough for common browser-uploaded assets.
    class finfo
    {
        public function __construct($flags = FILEINFO_MIME_TYPE)
        {
        }

        public function file($filename, $flags = null, $context = null)
        {
            if (function_exists('getimagesize')) {
                $imageInfo = @getimagesize($filename);
                if (is_array($imageInfo) && !empty($imageInfo['mime'])) {
                    return $imageInfo['mime'];
                }
            }

            $handle = @fopen($filename, 'rb');
            $head = $handle ? (string) fread($handle, 64) : '';
            if ($handle) {
                fclose($handle);
            }

            if (strncmp($head, "\\xFF\\xD8\\xFF", 3) === 0) {
                return 'image/jpeg';
            }
            if (strncmp($head, "\\x89PNG\\r\\n\\x1A\\n", 8) === 0) {
                return 'image/png';
            }
            if (strncmp($head, 'GIF87a', 6) === 0 || strncmp($head, 'GIF89a', 6) === 0) {
                return 'image/gif';
            }
            if (strncmp($head, 'RIFF', 4) === 0 && substr($head, 8, 4) === 'WEBP') {
                return 'image/webp';
            }
            if (strncmp($head, 'RIFF', 4) === 0 && substr($head, 8, 4) === 'WAVE') {
                return 'audio/wav';
            }
            if (strncmp($head, 'OggS', 4) === 0) {
                return 'application/ogg';
            }
            if (strncmp($head, 'ID3', 3) === 0 || strncmp($head, "\\xFF\\xFB", 2) === 0 || strncmp($head, "\\xFF\\xF3", 2) === 0 || strncmp($head, "\\xFF\\xF2", 2) === 0) {
                return 'audio/mpeg';
            }
            if (strncmp($head, "%PDF-", 5) === 0) {
                return 'application/pdf';
            }
            if (strncmp($head, "PK\\x03\\x04", 4) === 0 || strncmp($head, "PK\\x05\\x06", 4) === 0 || strncmp($head, "PK\\x07\\x08", 4) === 0) {
                return 'application/zip';
            }
            if (strncmp($head, 'glTF', 4) === 0) {
                return 'model/gltf-binary';
            }
            if (strlen($head) >= 12 && substr($head, 4, 4) === 'ftyp') {
                $majorBrand = substr($head, 8, 4);
                $videoBrands = ['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'M4V ', 'MSNV', 'dash'];
                $audioBrands = ['M4A ', 'M4B ', 'f4a ', 'f4b '];
                if (in_array($majorBrand, $audioBrands, true)) {
                    return 'audio/mp4';
                }
                if (in_array($majorBrand, $videoBrands, true)) {
                    return 'video/mp4';
                }
            }
            if (strncmp($head, "\\x1A\\x45\\xDF\\xA3", 4) === 0) {
                return 'video/webm';
            }
            if (preg_match('/<svg\\b/i', $head)) {
                return 'image/svg+xml';
            }
            if (preg_match('/^solid\\s+/i', $head)) {
                return 'model/stl';
            }

            $extension = strtolower((string) pathinfo((string) $filename, PATHINFO_EXTENSION));
            $byExtension = [
                'elpx' => 'application/zip',
                'gif' => 'image/gif',
                'glb' => 'model/gltf-binary',
                'jpeg' => 'image/jpeg',
                'jpg' => 'image/jpeg',
                'json' => 'application/json',
                'm4a' => 'audio/mp4',
                'mp3' => 'audio/mpeg',
                'mp4' => 'video/mp4',
                'oga' => 'audio/ogg',
                'ogg' => 'audio/ogg',
                'ogv' => 'video/ogg',
                'pdf' => 'application/pdf',
                'png' => 'image/png',
                'stl' => 'model/stl',
                'svg' => 'image/svg+xml',
                'txt' => 'text/plain',
                'wav' => 'audio/wav',
                'webm' => 'video/webm',
                'webp' => 'image/webp',
                'zip' => 'application/zip',
            ];

            return $byExtension[$extension] ?? 'application/octet-stream';
        }
    }
}
${debugBlock}
`;
}

function buildInstallScript(config, manifestState, blueprint, addonsState) {
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
  'addons' => json_decode('${phpString(JSON.stringify(addonsState))}', true),
  'installedAt' => gmdate('c'),
];

$warnings = [];
$shouldRerunBootstrap = false;
$themeSpecsByName = [];
foreach (($blueprint['themes'] ?? []) as $themeSpec) {
  $themeName = trim((string) ($themeSpec['name'] ?? ''));
  if ($themeName !== '') {
    $themeSpecsByName[$themeName] = $themeSpec;
  }
}

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

$findExistingMediaBySource = function (int $itemId, string $source) use ($entityManager) {
  $item = $entityManager->find(Omeka\\Entity\\Item::class, $itemId);
  if (!$item) {
    return null;
  }

  return $entityManager->getRepository(Omeka\\Entity\\Media::class)->findOneBy([
    'item' => $item,
    'source' => $source,
  ]);
};

$flattenErrors = function ($messages) use (&$flattenErrors) {
  $flattened = [];
  foreach ((array) $messages as $key => $value) {
    if (is_array($value)) {
      foreach ($flattenErrors($value) as $nested) {
        $flattened[] = is_string($key) && $key !== '' ? sprintf('%s: %s', $key, $nested) : $nested;
      }
      continue;
    }

    if ($value instanceof Stringable) {
      $flattened[] = (string) $value;
      continue;
    }

    if ($value !== null && $value !== '') {
      $flattened[] = (string) $value;
    }
  }
  return $flattened;
};

$describeThrowable = function (Throwable $e) use ($flattenErrors) {
  $parts = [];
  $message = trim($e->getMessage());
  if ($message !== '') {
    $parts[] = $message;
  }
  if (method_exists($e, 'getErrorStore')) {
    $errors = $e->getErrorStore()->getErrors();
    $flattened = $flattenErrors($errors);
    if ($flattened) {
      $parts[] = implode(' | ', array_unique($flattened));
    }
  }
  return $parts ? implode(' | ', $parts) : get_class($e);
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
    $sourceType = strtolower(trim((string) (($moduleSpec['source']['type'] ?? 'bundled'))));
    if ($sourceType !== 'bundled') {
      throw new RuntimeException(sprintf('Module "%s" was requested from source type "%s" but is still missing from the runtime filesystem.', $moduleName, $sourceType));
    }

    $warnings[] = sprintf('Module "%s" is not present in the bundled Omeka filesystem.', $moduleName);
    continue;
  }

  $state = $normalizeModuleState($moduleSpec['state'] ?? 'activate');
  $moduleState = $module->getState();

  if ($moduleState === Omeka\\Module\\Manager::STATE_NOT_INSTALLED && in_array($state, ['install', 'activate'], true)) {
    $moduleManager->install($module);
    $shouldRerunBootstrap = true;
    break;
  }

  if ($moduleState === Omeka\\Module\\Manager::STATE_NOT_ACTIVE && $state === 'activate') {
    $moduleManager->activate($module);
    $shouldRerunBootstrap = true;
    break;
  }
}

if ($shouldRerunBootstrap) {
  file_put_contents($statePath, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  echo "omeka-playground-bootstrap-continue\\n";
  foreach ($warnings as $warning) {
    echo "[warning] " . $warning . "\\n";
  }
  exit(0);
}

$siteSpec = $blueprint['site'] ?? null;
$siteResource = null;
if (is_array($siteSpec) && !empty($siteSpec['title'])) {
  $themeName = trim((string) ($siteSpec['theme'] ?? 'default'));
  if (!$themeManager->getTheme($themeName)) {
    $themeSpec = $themeSpecsByName[$themeName] ?? null;
    $sourceType = strtolower(trim((string) (($themeSpec['source']['type'] ?? 'bundled'))));
    if ($sourceType !== 'bundled') {
      throw new RuntimeException(sprintf('Theme "%s" was requested from source type "%s" but is still missing from the runtime filesystem.', $themeName, $sourceType));
    }

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

  try {
    $itemId = null;
    if ($existing) {
      $apiManager->update('items', $existing->id(), $payload);
      $itemId = $existing->id();
      $debug(sprintf('Updated item "%s" (#%s).', $itemSpec['title'], $existing->id()));
    } else {
      $response = $apiManager->create('items', $payload);
      $itemId = $response->getContent()->id();
      $debug(sprintf('Created item "%s" (#%s).', $itemSpec['title'], $itemId));
    }

    if (!$itemId) {
      continue;
    }

    foreach (($itemSpec['media'] ?? []) as $mediaSpec) {
      if (($mediaSpec['type'] ?? 'url') !== 'url' || empty($mediaSpec['url'])) {
        continue;
      }

      $mediaSource = trim((string) $mediaSpec['url']);
      if ($mediaSource === '') {
        continue;
      }

      if ($findExistingMediaBySource($itemId, $mediaSource)) {
        $debug(sprintf('Skipped media "%s" for item "%s" (#%s) because it already exists.', $mediaSource, $itemSpec['title'], $itemId));
        continue;
      }

      $cachedPath = isset($mediaSpec['cachedPath']) ? trim((string) $mediaSpec['cachedPath']) : '';
      $mediaPayload = [
        'o:item' => ['o:id' => $itemId],
        'o:source' => $mediaSource,
      ];
      if (!empty($mediaSpec['title'])) {
        $mediaPayload['dcterms:title'] = $literalValues($titlePropertyId, $mediaSpec['title']);
      }
      if (!empty($mediaSpec['altText'])) {
        $mediaPayload['o:alt_text'] = $mediaSpec['altText'];
      }

      try {
        if ($cachedPath !== '' && is_readable($cachedPath)) {
          $mediaPayload['o:ingester'] = 'playground_cached_file';
          $mediaPayload['playground_cached_path'] = $cachedPath;
          $mediaPayload['playground_cached_name'] = !empty($mediaSpec['cachedName']) ? $mediaSpec['cachedName'] : basename($cachedPath);
          $mediaResponse = $apiManager->create('media', $mediaPayload);
        } else {
          $mediaPayload['o:ingester'] = 'url';
          $mediaPayload['ingest_url'] = $mediaSource;
          $mediaResponse = $apiManager->create('media', $mediaPayload);
        }
        $debug(sprintf('Created media for item "%s" (#%s) from "%s" (#%s).', $itemSpec['title'], $itemId, $mediaSource, $mediaResponse->getContent()->id()));
      } catch (Throwable $e) {
        $warnings[] = sprintf('Unable to attach media "%s" to item "%s": %s', $mediaSource, $itemSpec['title'], $describeThrowable($e));
      }
    }
  } catch (Throwable $e) {
    $warnings[] = sprintf('Unable to provision item "%s": %s', $itemSpec['title'], $describeThrowable($e));
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

function extractCsrfField(html) {
  const match = html.match(/<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+_csrf|csrf)["'][^>]+value=["']([^"']*)["'][^>]*>/iu);
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    value: match[2],
  };
}

function buildFormUrlEncoded(payload) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    body.set(key, value);
  }
  return body.toString();
}

function isLoginPage(html) {
  return /<body[^>]*class=["'][^"']*\blogin\b[^"']*["']/iu.test(html)
    || /<h1>\s*Log in\s*<\/h1>/iu.test(html);
}

async function performAutologin(php, config, publish) {
  publish("Signing in admin user automatically.", 0.9);

  const loginUrl = "https://playground.internal/login";
  const adminUrl = "https://playground.internal/admin";

  const loginPage = await php.request(new Request(loginUrl));
  const loginHtml = await loginPage.text();
  const csrfField = extractCsrfField(loginHtml);

  const formPayload = {
    email: config.admin.email,
    password: config.admin.password,
    submit: "Log in",
  };

  if (csrfField) {
    formPayload[csrfField.name] = csrfField.value;
  }

  const loginResponse = await php.request(new Request(loginUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: buildFormUrlEncoded(formPayload),
  }));

  const location = loginResponse.headers.get("location") || "";
  if (location && /\/admin(?:\/|$)?/u.test(location)) {
    return {
      ok: true,
      path: "/admin",
    };
  }

  const adminResponse = await php.request(new Request(adminUrl));
  const adminHtml = await adminResponse.text();
  const adminLocation = adminResponse.headers.get("location") || "";
  const landedOnLogin = /\/login(?:\/|$)?/u.test(adminLocation) || isLoginPage(adminHtml);

  if (landedOnLogin) {
    return {
      ok: false,
      path: "/login",
      warning: "Automatic admin login did not establish a browser session.",
    };
  }

  return {
    ok: true,
    path: "/admin",
  };
}

function buildPhpIni(config) {
  const debugEnabled = config.debug?.enabled === true;

  return [
    `display_errors=${debugEnabled ? 1 : 0}`,
    `display_startup_errors=${debugEnabled ? 1 : 0}`,
    `error_reporting=${debugEnabled ? "E_ALL" : "E_ALL & ~E_DEPRECATED"}`,
    "memory_limit=512M",
    "max_execution_time=30",
    "allow_url_fopen=1",
    `auto_prepend_file=${PLAYGROUND_PREPEND_PATH}`,
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
    "/persist/addons",
    "/persist/mutable",
    "/persist/mutable/config",
    "/persist/mutable/db",
    "/persist/mutable/files",
    "/persist/mutable/logs",
    "/persist/mutable/session",
    "/persist/runtime",
    PLAYGROUND_BLUEPRINT_MEDIA_PATH,
  ]) {
    await ensureDir(php, path);
  }
}

async function resetPersistedState(php) {
  const binary = await php.binary;
  const { FS } = binary;
  const persistedRoot = "/persist";
  const about = FS.analyzePath(persistedRoot);
  if (!about.exists) {
    return;
  }

  for (const entry of FS.readdir(persistedRoot)) {
    if (entry === "." || entry === "..") {
      continue;
    }
    removeNodeIfPresent(FS, `${persistedRoot}/${entry}`.replace(/\/{2,}/gu, "/"));
  }
}

function sanitizeMediaFilename(value, fallback = "media.bin") {
  const normalized = String(value || "").trim().replace(/[?#].*$/u, "");
  const candidate = normalized.split("/").filter(Boolean).pop() || fallback;
  const sanitized = candidate.replace(/[^a-zA-Z0-9._-]/gu, "_");
  return sanitized || fallback;
}

function buildBlueprintMediaCachePath(itemIndex, mediaIndex, filename) {
  const safeName = sanitizeMediaFilename(filename, `media-${itemIndex + 1}-${mediaIndex + 1}.bin`);
  return `${PLAYGROUND_BLUEPRINT_MEDIA_PATH}/item-${itemIndex + 1}-media-${mediaIndex + 1}-${safeName}`;
}

async function cacheBlueprintMediaFiles({ php, blueprint, publish }) {
  const stagedBlueprint = structuredClone(blueprint);
  const items = Array.isArray(stagedBlueprint.items) ? stagedBlueprint.items : [];

  for (const [itemIndex, item] of items.entries()) {
    const mediaEntries = Array.isArray(item.media) ? item.media : [];
    for (const [mediaIndex, media] of mediaEntries.entries()) {
      if ((media?.type || "url") !== "url" || !media?.url) {
        continue;
      }

      const sourceUrl = String(media.url).trim();
      if (!sourceUrl) {
        continue;
      }

      try {
        const directFetch = globalThis.__omekaOriginalFetch || globalThis.fetch.bind(globalThis);
        const response = await directFetch(sourceUrl, { redirect: "follow" });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const cachedName = sanitizeMediaFilename(new URL(response.url || sourceUrl, sourceUrl).pathname, `media-${itemIndex + 1}-${mediaIndex + 1}.bin`);
        const cachedPath = buildBlueprintMediaCachePath(itemIndex, mediaIndex, cachedName);
        await php.writeFile(cachedPath, bytes);
        media.cachedPath = cachedPath;
        media.cachedName = cachedName;
      } catch (error) {
        const detail = error?.message ? String(error.message) : String(error);
        publish(`[warning] Unable to prefetch media "${sourceUrl}" for blueprint item "${item.title || `#${itemIndex + 1}`}": ${detail}`, 0.56);
      }
    }
  }

  return stagedBlueprint;
}

function removeNodeIfPresent(FS, path) {
  const about = FS.analyzePath(path);
  if (!about.exists) {
    return;
  }

  const mode = about.object?.mode;
  if (typeof mode === "number" && FS.isDir(mode)) {
    for (const entry of FS.readdir(path)) {
      if (entry === "." || entry === "..") {
        continue;
      }
      removeNodeIfPresent(FS, `${path}/${entry}`.replace(/\/{2,}/gu, "/"));
    }
    FS.rmdir(path);
    return;
  }

  FS.unlink(path);
}

async function linkMutableFilesDir(php) {
  const binary = await php.binary;
  const { FS } = binary;
  const targetPath = `${OMEKA_ROOT}/files`;
  const about = FS.analyzePath(targetPath);

  if (about.exists) {
    const mode = about.object?.mode;
    if (typeof mode === "number" && FS.isLink(mode)) {
      const existingTarget = FS.readlink(targetPath);
      if (existingTarget === OMEKA_FILES_PATH) {
        return;
      }
    }

    removeNodeIfPresent(FS, targetPath);
  }

  FS.symlink(OMEKA_FILES_PATH, targetPath);
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
  await php.writeFile(PLAYGROUND_PREPEND_PATH, encoder.encode(buildPhpPrepend(config)));
}

export async function bootstrapOmeka({ blueprint, clean = false, config, php, publish, runtimeId }) {
  const normalizedBlueprint = normalizeBlueprint(blueprint, config);
  const effectiveConfig = buildEffectivePlaygroundConfig(config, normalizedBlueprint);

  if (clean) {
    publish("Resetting persisted runtime state.", 0.16);
    await resetPersistedState(php);
  }

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
  await mountReadonlyCore(php, manifest, { root: OMEKA_ROOT });
  await linkMutableFilesDir(php);

  publish("Preparing blueprint modules and themes.", 0.52);
  const addonsState = await materializeBlueprintAddons({
    php,
    blueprint: normalizedBlueprint,
    omekaRoot: OMEKA_ROOT,
    publish,
    config: effectiveConfig,
  });

  publish("Prefetching blueprint media files.", 0.56);
  const runtimeBlueprint = await cacheBlueprintMediaFiles({
    php,
    blueprint: normalizedBlueprint,
    publish,
  });

  publish("Writing SQLite and local config overrides.", 0.6);
  await php.writeFile(`${OMEKA_ROOT}/config/database.ini`, encoder.encode(buildDatabaseIni()));
  await php.writeFile(`${OMEKA_ROOT}/config/local.config.php`, encoder.encode(buildLocalConfig(effectiveConfig)));
  await appendPhpIniOverrides(php, effectiveConfig);
  await php.writeFile(`${OMEKA_ROOT}/playground-probe.php`, encoder.encode(buildProbeScript()));

  const probeResponse = await php.request(new Request("https://playground.internal/playground-probe.php"));
  const probeText = await probeResponse.text();
  let probe;
  try {
    probe = JSON.parse(probeText);
  } catch (error) {
    const preview = probeText.slice(0, 800);
    throw new Error(`Probe response was not valid JSON: ${preview}`);
  }

  if (!probe.available_drivers?.includes("sqlite")) {
    throw new Error(`SQLite probe failed: ${probeText}`);
  }

  publish("Running automatic Omeka installer if needed.", 0.64);
  await php.writeFile(`${OMEKA_ROOT}/playground-install.php`, encoder.encode(buildInstallScript(effectiveConfig, manifestState, runtimeBlueprint, addonsState)));

  let bootstrapComplete = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const output = await php.request(new Request("https://playground.internal/playground-install.php"));
    const outputText = await output.text();
    const outputLines = outputText
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of outputLines) {
      if (line === "omeka-playground-bootstrap-complete" || line === "omeka-playground-bootstrap-continue") {
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

    if (outputText.includes("omeka-playground-bootstrap-complete")) {
      bootstrapComplete = true;
      break;
    }

    if (outputText.includes("omeka-playground-bootstrap-continue")) {
      publish("Reinitializing Omeka after module install.", 0.72);
      continue;
    }

    throw new Error(`Unexpected Omeka bootstrap output: ${outputText}`);
  }

  if (!bootstrapComplete) {
    throw new Error("Omeka bootstrap did not complete after repeated module install passes.");
  }

  let readyPath = runtimeBlueprint.landingPage || effectiveConfig.landingPath || "/admin";

  if (effectiveConfig.autologin) {
    const autologin = await performAutologin(php, effectiveConfig, publish);
    readyPath = autologin.ok ? autologin.path : (autologin.path || readyPath);
    if (autologin.warning) {
      publish(`[warning] ${autologin.warning}`, 0.92);
    }
  }

  publish("Bootstrap complete. Omeka is ready.", 0.96);

  return {
    manifest,
    manifestState,
    readyPath,
  };
}
