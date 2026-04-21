/**
 * Single source of truth for supported Omeka S versions, PHP versions,
 * and compatibility matrix. Inspired by moodle-playground's
 * src/shared/version-resolver.js.
 *
 * The `source` field describes how scripts/build-omeka-bundle.sh should
 * fetch the source tree for each version. It is not consumed by the
 * browser runtime.
 */

export const OMEKA_VERSIONS = [
  {
    version: "4.1.1",
    label: "Omeka S 4.1.1",
    slug: "4.1.1",
    manifestFile: "4.1.1.json",
    bundleDir: "4.1.1",
    phpVersions: ["8.1", "8.2", "8.3", "8.4", "8.5"],
    source: {
      type: "release-zip",
      url: "https://github.com/omeka/omeka-s/releases/download/v4.1.1/omeka-s-4.1.1.zip",
    },
    default: false,
  },
  {
    version: "4.2.0",
    label: "Omeka S 4.2.0 (experimental SQLite)",
    slug: "4.2.0",
    manifestFile: "4.2.0.json",
    bundleDir: "4.2.0",
    phpVersions: ["8.1", "8.2", "8.3", "8.4", "8.5"],
    source: {
      type: "git",
      repository: "https://github.com/ateeducacion/omeka-s.git",
      branch: "feature/experimental-sqlite-support",
    },
    default: true,
  },
];

export const ALL_PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4", "8.5"];
export const DEFAULT_PHP_VERSION = "8.3";
export const DEFAULT_OMEKA_VERSION = (
  OMEKA_VERSIONS.find((entry) => entry.default) || OMEKA_VERSIONS[0]
).version;

function normalizeStringParam(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

/**
 * Get the metadata object for a given Omeka version.
 */
export function getOmekaVersionMetadata(version) {
  if (!version) {
    return null;
  }
  const needle = String(version).trim();
  return (
    OMEKA_VERSIONS.find(
      (entry) => entry.version === needle || entry.slug === needle,
    ) || null
  );
}

/**
 * Get the default Omeka version metadata.
 */
export function getDefaultOmekaVersion() {
  return OMEKA_VERSIONS.find((entry) => entry.default) || OMEKA_VERSIONS[0];
}

/**
 * Return the list of PHP versions compatible with a given Omeka version.
 */
export function getCompatiblePhpVersions(version) {
  const meta = getOmekaVersionMetadata(version);
  return meta ? meta.phpVersions : [DEFAULT_PHP_VERSION];
}

/**
 * Check whether a PHP version is compatible with an Omeka version.
 */
export function isCompatibleCombination(phpVersion, omekaVersion) {
  const meta = getOmekaVersionMetadata(omekaVersion);
  if (!meta) {
    return false;
  }
  return meta.phpVersions.includes(phpVersion);
}

/**
 * Resolve an Omeka version string (e.g. "4.1", "4.1.1", "4.2") to the
 * canonical version string declared in OMEKA_VERSIONS. Returns null if
 * no match is found.
 */
export function resolveOmekaVersion(input) {
  const needle = normalizeStringParam(input);
  if (!needle) {
    return null;
  }

  const direct = getOmekaVersionMetadata(needle);
  if (direct) {
    return direct.version;
  }

  // Loose "major.minor" match — pick the first declared patch version for
  // that minor line (e.g. "4.1" -> "4.1.1").
  const minorMatch = needle.match(/^(\d+)\.(\d+)$/u);
  if (minorMatch) {
    const prefix = `${minorMatch[1]}.${minorMatch[2]}.`;
    const byMinor = OMEKA_VERSIONS.find((entry) =>
      entry.version.startsWith(prefix),
    );
    if (byMinor) {
      return byMinor.version;
    }
  }

  return null;
}

/**
 * Build a runtime ID encoding both PHP version and Omeka version.
 * e.g., "php83-omeka420", "php83-omeka411".
 */
export function buildRuntimeId(phpVersion, omekaVersion) {
  const phpPart = `php${String(phpVersion).replace(".", "")}`;
  const meta = getOmekaVersionMetadata(omekaVersion);
  const omekaPart = meta
    ? `omeka${meta.version.replaceAll(".", "")}`
    : `omeka${String(omekaVersion).replaceAll(/[^A-Za-z0-9]/gu, "")}`;
  return `${phpPart}-${omekaPart}`;
}

/**
 * Parse a runtime ID back to { phpVersion, omekaVersion }.
 *
 * Accepts the new "phpXY-omekaNNN" format and the legacy "phpXY" format
 * (which maps to the default Omeka version).
 */
export function parseRuntimeId(runtimeId) {
  if (!runtimeId || typeof runtimeId !== "string") {
    return null;
  }

  const newMatch = runtimeId.match(/^php(\d)(\d)-omeka(\d+)$/u);
  if (newMatch) {
    const phpVersion = `${newMatch[1]}.${newMatch[2]}`;
    const digits = newMatch[3];
    const byExact = OMEKA_VERSIONS.find(
      (entry) => entry.version.replaceAll(".", "") === digits,
    );
    if (byExact) {
      return { phpVersion, omekaVersion: byExact.version };
    }

    // Tolerate shortened forms like "omeka41" -> try "4.1" loose match.
    if (digits.length >= 2) {
      const loose = resolveOmekaVersion(
        `${digits[0]}.${digits.slice(1)}`.replace(
          /^(\d+)\.(\d)(\d+)$/u,
          "$1.$2.$3",
        ),
      );
      if (loose) {
        return { phpVersion, omekaVersion: loose };
      }
    }
  }

  const legacyMatch = runtimeId.match(/^php(\d)(\d)(?:-cgi)?$/u);
  if (legacyMatch) {
    return {
      phpVersion: `${legacyMatch[1]}.${legacyMatch[2]}`,
      omekaVersion: DEFAULT_OMEKA_VERSION,
    };
  }

  return null;
}

/**
 * Resolve version selections from URL params, blueprint, runtime id, or
 * defaults. Precedence: explicit params > blueprint > runtime id > default.
 */
export function resolveVersions({
  php,
  phpVersion,
  omeka,
  omekaVersion,
  runtimeId,
} = {}) {
  const parsedRuntime = parseRuntimeId(runtimeId);

  let resolvedOmeka = null;
  if (omekaVersion) {
    resolvedOmeka = resolveOmekaVersion(omekaVersion);
  }
  if (!resolvedOmeka && omeka) {
    resolvedOmeka = resolveOmekaVersion(omeka);
  }
  if (!resolvedOmeka && parsedRuntime?.omekaVersion) {
    resolvedOmeka = parsedRuntime.omekaVersion;
  }
  if (!resolvedOmeka) {
    resolvedOmeka = DEFAULT_OMEKA_VERSION;
  }

  let resolvedPhp =
    normalizeStringParam(phpVersion) || normalizeStringParam(php);
  if (!resolvedPhp && parsedRuntime?.phpVersion) {
    resolvedPhp = parsedRuntime.phpVersion;
  }
  if (resolvedPhp && !isCompatibleCombination(resolvedPhp, resolvedOmeka)) {
    resolvedPhp = null;
  }
  if (!resolvedPhp) {
    const compatible = getCompatiblePhpVersions(resolvedOmeka);
    resolvedPhp = compatible.includes(DEFAULT_PHP_VERSION)
      ? DEFAULT_PHP_VERSION
      : compatible[0];
  }

  return { phpVersion: resolvedPhp, omekaVersion: resolvedOmeka };
}

export function resolveRuntimeSelection(options = {}) {
  const resolved = resolveVersions(options);
  return {
    phpVersion: resolved.phpVersion,
    omekaVersion: resolved.omekaVersion,
    runtimeId: buildRuntimeId(resolved.phpVersion, resolved.omekaVersion),
  };
}

export function buildRuntimeLabel(phpVersion, omekaVersion) {
  const meta = getOmekaVersionMetadata(omekaVersion);
  return `PHP ${phpVersion} + ${meta?.label || `Omeka S ${omekaVersion}`}`;
}

/**
 * Resolve a runtime config entry for the given selection, synthesising a
 * new entry if no exact match exists in playground.config.json. This lets
 * the config keep only a curated list of runtimes while the UI can still
 * offer every valid (php, omeka) combination.
 */
export function resolveRuntimeConfig(config, selection) {
  const baseRuntime =
    config?.runtimes?.find((runtime) => runtime.default) ||
    config?.runtimes?.[0];
  if (!baseRuntime) {
    return null;
  }

  const runtimeId = selection?.runtimeId || baseRuntime.id;
  const resolvedSelection =
    selection?.phpVersion && selection?.omekaVersion
      ? selection
      : resolveRuntimeSelection({ runtimeId });

  const exactRuntime = config.runtimes.find((entry) => entry.id === runtimeId);
  if (exactRuntime) {
    return exactRuntime;
  }

  const equivalentRuntime = config.runtimes.find((entry) => {
    const parsed = parseRuntimeId(entry.id);
    return (
      parsed &&
      parsed.phpVersion === resolvedSelection.phpVersion &&
      parsed.omekaVersion === resolvedSelection.omekaVersion
    );
  });

  return {
    ...(equivalentRuntime || baseRuntime),
    id: resolvedSelection.runtimeId,
    label: buildRuntimeLabel(
      resolvedSelection.phpVersion,
      resolvedSelection.omekaVersion,
    ),
    phpVersion: resolvedSelection.phpVersion,
    omekaVersion: resolvedSelection.omekaVersion,
  };
}

/**
 * Parse URL query params for version configuration.
 */
export function parseQueryParams(urlOrSearchParams) {
  let params;
  if (urlOrSearchParams instanceof URLSearchParams) {
    params = urlOrSearchParams;
  } else if (typeof urlOrSearchParams === "string") {
    params = new URL(urlOrSearchParams).searchParams;
  } else if (urlOrSearchParams?.searchParams) {
    params = urlOrSearchParams.searchParams;
  } else if (typeof urlOrSearchParams?.search === "string") {
    params = new URLSearchParams(urlOrSearchParams.search);
  } else {
    params = new URLSearchParams();
  }

  return {
    php: params.get("php") || params.get("phpVersion") || null,
    phpVersion: params.get("phpVersion") || null,
    omeka: params.get("omeka") || null,
    omekaVersion: params.get("omekaVersion") || null,
  };
}

/**
 * Build the manifest URL for a given Omeka version.
 */
export function buildManifestFilename(omekaVersion) {
  const meta = getOmekaVersionMetadata(omekaVersion);
  return meta ? meta.manifestFile : "latest.json";
}
