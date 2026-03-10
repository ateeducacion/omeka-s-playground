#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-omeka"}
DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/omeka"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
RUNTIME_VERSION=${RUNTIME_VERSION:-"0.0.9-alpha-32"}
SOURCE_DIR=$("$SCRIPT_DIR/fetch-omeka-source.sh")
STAGE_DIR="$WORK_DIR/stage"
OMEKA_STAGE="$STAGE_DIR/omeka"

rm -rf "$STAGE_DIR"
mkdir -p "$OMEKA_STAGE" "$DIST_DIR" "$MANIFEST_DIR"

cp -R "$SOURCE_DIR"/. "$OMEKA_STAGE"
rm -rf "$OMEKA_STAGE/.git" "$OMEKA_STAGE/node_modules" "$OMEKA_STAGE/.github" "$OMEKA_STAGE/tests"

if command -v composer >/dev/null 2>&1; then
  composer install --working-dir="$OMEKA_STAGE" --no-dev --prefer-dist --no-progress --no-interaction >&2
else
  echo "composer is required to materialize Omeka vendor dependencies for the browser bundle." >&2
  exit 1
fi

SOURCE_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
RELEASE=$(php -r 'preg_match("/const VERSION = \x27([^\x27]+)\x27;/", file_get_contents("'"$OMEKA_STAGE"'/application/Module.php"), $m); echo $m[1] ?? "unknown";')
SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
VFS_DATA_PATH="$DIST_DIR/omeka-core-$SAFE_RELEASE.vfs.bin"
VFS_INDEX_PATH="$DIST_DIR/omeka-core-$SAFE_RELEASE.vfs.index.json"
MANIFEST_PATH="$MANIFEST_DIR/latest.json"
FILE_COUNT=$(find "$OMEKA_STAGE" -type f | wc -l | tr -d ' ')

node "$SCRIPT_DIR/build-vfs-image.mjs" \
  --source "$OMEKA_STAGE" \
  --data "$VFS_DATA_PATH" \
  --index "$VFS_INDEX_PATH"

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --channel browser \
  --manifest "$MANIFEST_PATH" \
  --runtimeVersion "$RUNTIME_VERSION" \
  --release "$RELEASE" \
  --sourceRepository "${OMEKA_REF:-https://github.com/ateeducacion/omeka-s.git}" \
  --sourceBranch "${OMEKA_REF_BRANCH:-feature/experimental-sqlite-support}" \
  --sourceCommit "$SOURCE_COMMIT" \
  --imageData "$VFS_DATA_PATH" \
  --imageIndex "$VFS_INDEX_PATH" \
  --fileCount "$FILE_COUNT"

echo "Omeka VFS written to $VFS_DATA_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2

