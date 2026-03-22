#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-omeka"}
DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/omeka"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
SOURCE_DIR=$("$SCRIPT_DIR/fetch-omeka-source.sh")
STAGE_DIR="$WORK_DIR/stage"
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

if command -v composer >/dev/null 2>&1; then
  composer install --working-dir="$OMEKA_STAGE" --no-dev --prefer-dist --no-progress --no-interaction --ignore-platform-reqs >&2
else
  echo "composer is required to materialize Omeka vendor dependencies for the browser bundle." >&2
  exit 1
fi

SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
RELEASE=$(php -r 'preg_match("/const VERSION = \x27([^\x27]+)\x27;/", file_get_contents("'"$OMEKA_STAGE"'/application/Module.php"), $m); echo $m[1] ?? "unknown";')
SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
BUNDLE_FILE="omeka-core-${SAFE_RELEASE}.zip"
BUNDLE_PATH="$DIST_DIR/$BUNDLE_FILE"
MANIFEST_PATH="$MANIFEST_DIR/latest.json"
FILE_COUNT=$(find "$OMEKA_STAGE" -type f | wc -l | tr -d ' ')

# Create ZIP bundle
echo "Creating ZIP bundle..." >&2
(cd "$OMEKA_STAGE" && zip -qr "$BUNDLE_PATH" .)
echo "Bundle created: $BUNDLE_PATH ($FILE_COUNT files)" >&2

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --channel browser \
  --manifest "$MANIFEST_PATH" \
  --release "$RELEASE" \
  --sourceRepository "${OMEKA_REF:-https://github.com/ateeducacion/omeka-s.git}" \
  --sourceBranch "${OMEKA_REF_BRANCH:-feature/experimental-sqlite-support}" \
  --sourceCommit "$SOURCE_COMMIT" \
  --bundle "$BUNDLE_PATH" \
  --fileCount "$FILE_COUNT"

echo "Bundle written to $BUNDLE_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2
