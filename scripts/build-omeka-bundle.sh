#!/bin/sh

# Build a readonly Omeka S bundle and manifest for a specific Omeka version.
#
# Usage:
#   OMEKA_VERSION=4.2.0 scripts/build-omeka-bundle.sh
#   OMEKA_VERSION=4.1.1 scripts/build-omeka-bundle.sh
#
# Environment:
#   OMEKA_VERSION     Required. Must match a version in
#                     src/shared/omeka-versions.js (default: the declared
#                     default version).
#   OMEKA_REF         Override the git remote URL (only used for source
#                     type "git" — backward compat with the old single
#                     version build).
#   OMEKA_REF_BRANCH  Override the git branch (same as above).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-omeka"}
DIST_ROOT=${DIST_ROOT:-"$REPO_DIR/assets/omeka"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}

# Resolve the requested version against the shared version resolver so the
# build script, the browser runtime, and the shell UI all share a single
# source of truth for supported versions.
VERSION_REQUEST=${OMEKA_VERSION:-}
META_JSON=$(node --input-type=module -e "
  import('${REPO_DIR}/src/shared/omeka-versions.js').then((m) => {
    const requested = process.env.VERSION_REQUEST || '';
    const resolved = requested ? m.resolveOmekaVersion(requested) : m.DEFAULT_OMEKA_VERSION;
    if (!resolved) {
      console.error(\`Unsupported OMEKA_VERSION: \${requested}\`);
      process.exit(2);
    }
    const meta = m.getOmekaVersionMetadata(resolved);
    process.stdout.write(JSON.stringify(meta));
  }).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
" VERSION_REQUEST="${VERSION_REQUEST}")

get_meta() {
  printf '%s' "$META_JSON" | node -e "
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => {
      const meta = JSON.parse(data);
      const key = process.argv[1];
      const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), meta);
      process.stdout.write(value == null ? '' : String(value));
    });
  " "$1"
}

VERSION=$(get_meta version)
SOURCE_TYPE=$(get_meta source.type)
MANIFEST_FILE=$(get_meta manifestFile)
BUNDLE_DIR_NAME=$(get_meta bundleDir)

if [ -z "$VERSION" ] || [ -z "$SOURCE_TYPE" ] || [ -z "$MANIFEST_FILE" ] || [ -z "$BUNDLE_DIR_NAME" ]; then
  echo "build-omeka-bundle: unable to resolve metadata for version '${VERSION_REQUEST:-<default>}'." >&2
  exit 2
fi

DIST_DIR="$DIST_ROOT/$BUNDLE_DIR_NAME"
MANIFEST_PATH="$MANIFEST_DIR/$MANIFEST_FILE"

case "$SOURCE_TYPE" in
  git)
    SOURCE_REPO=${OMEKA_REF:-$(get_meta source.repository)}
    SOURCE_BRANCH=${OMEKA_REF_BRANCH:-$(get_meta source.branch)}
    SOURCE_DIR=$("$SCRIPT_DIR/fetch-omeka-source.sh" "$SOURCE_REPO" "$SOURCE_BRANCH" "$VERSION")
    SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
    SOURCE_URL="$SOURCE_REPO"
    SOURCE_REF="$SOURCE_BRANCH"
    ;;
  release-zip)
    RELEASE_URL=$(get_meta source.url)
    SOURCE_DIR=$("$SCRIPT_DIR/fetch-omeka-release.sh" "$VERSION" "$RELEASE_URL")
    SOURCE_COMMIT=""
    SOURCE_URL="$RELEASE_URL"
    SOURCE_REF="v$VERSION"
    ;;
  *)
    echo "build-omeka-bundle: unsupported source type '$SOURCE_TYPE'." >&2
    exit 2
    ;;
esac

STAGE_DIR="$WORK_DIR/$BUNDLE_DIR_NAME/stage"
OMEKA_STAGE="$STAGE_DIR/omeka"

rm -rf "$STAGE_DIR"
mkdir -p "$OMEKA_STAGE" "$DIST_DIR" "$MANIFEST_DIR"

cp -R "$SOURCE_DIR"/. "$OMEKA_STAGE"
rm -rf "$OMEKA_STAGE/.git" "$OMEKA_STAGE/node_modules" "$OMEKA_STAGE/.github" "$OMEKA_STAGE/tests"

# The browser runtime currently lacks fileinfo. Keep the web bundle bootable
# by relaxing the environment gate while we work on a custom runtime build.
perl -0pi -e "s/const PHP_REQUIRED_EXTENSIONS = \\['fileinfo', 'mbstring', 'PDO', 'xml'\\];/const PHP_REQUIRED_EXTENSIONS = ['mbstring', 'PDO'];/" \
  "$OMEKA_STAGE/application/src/Stdlib/Environment.php"

# Keep the browser bundle self-contained. Remote fonts and external CDN assets
# are brittle under SW-scoped static hosting, so force local assets only.
perl -0pi -e "s/'use_externals' => true/'use_externals' => false/" \
  "$OMEKA_STAGE/application/config/module.config.php"
perl -0pi -e "s/\\n\\\$this->headLink\\(\\)->prependStylesheet\\('\\/\\/fonts\\.googleapis\\.com[^\\n]+;//g" \
  "$OMEKA_STAGE/application/view/layout/layout-admin.phtml" \
  "$OMEKA_STAGE/application/view/layout/layout.phtml" \
  "$OMEKA_STAGE/application/view/common/user-bar.phtml"

if [ ! -d "$OMEKA_STAGE/vendor" ]; then
  if command -v composer >/dev/null 2>&1; then
    composer install --working-dir="$OMEKA_STAGE" --no-dev --prefer-dist --no-progress --no-interaction --ignore-platform-reqs >&2
  else
    echo "composer is required to materialize Omeka vendor dependencies for the browser bundle." >&2
    exit 1
  fi
fi

RELEASE=$(php -r 'preg_match("/const VERSION = \x27([^\x27]+)\x27;/", file_get_contents("'"$OMEKA_STAGE"'/application/Module.php"), $m); echo $m[1] ?? "unknown";')
if [ -z "$RELEASE" ] || [ "$RELEASE" = "unknown" ]; then
  RELEASE="$VERSION"
fi
SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
BUNDLE_FILE="omeka-core-${SAFE_RELEASE}.zip"
BUNDLE_PATH="$DIST_DIR/$BUNDLE_FILE"
FILE_COUNT=$(find "$OMEKA_STAGE" -type f | wc -l | tr -d ' ')

# Drop any stale bundle(s) in this version's dist dir so the manifest path
# always points at the freshly built artifact.
find "$DIST_DIR" -maxdepth 1 -type f -name 'omeka-core-*.zip' ! -name "$BUNDLE_FILE" -delete 2>/dev/null || true

echo "Creating ZIP bundle for Omeka $RELEASE..." >&2
(cd "$OMEKA_STAGE" && zip -qr "$BUNDLE_PATH" .)
echo "Bundle created: $BUNDLE_PATH ($FILE_COUNT files)" >&2

MANIFEST_ARGS="--channel browser --manifest $MANIFEST_PATH --release $RELEASE --sourceRepository $SOURCE_URL --sourceBranch $SOURCE_REF --bundle $BUNDLE_PATH --fileCount $FILE_COUNT"
if [ -n "$SOURCE_COMMIT" ]; then
  MANIFEST_ARGS="$MANIFEST_ARGS --sourceCommit $SOURCE_COMMIT"
fi

# Intentionally unquoted so shell word-splitting produces separate argv entries.
# shellcheck disable=SC2086
node "$SCRIPT_DIR/generate-manifest.mjs" $MANIFEST_ARGS

# Keep the legacy manifest URL pointing at whichever version is default so
# callers that haven't migrated to version-specific URLs still work.
DEFAULT_VERSION=$(node --input-type=module -e "
  import('${REPO_DIR}/src/shared/omeka-versions.js').then((m) => {
    process.stdout.write(m.DEFAULT_OMEKA_VERSION);
  });
")
if [ "$VERSION" = "$DEFAULT_VERSION" ]; then
  cp "$MANIFEST_PATH" "$MANIFEST_DIR/latest.json"
  echo "Also wrote $MANIFEST_DIR/latest.json (default version alias)" >&2
fi

echo "Bundle written to $BUNDLE_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2
