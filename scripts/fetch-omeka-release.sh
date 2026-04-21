#!/bin/sh

# Fetch an Omeka S release ZIP from GitHub and extract it into a cache
# directory. Prints the absolute path of the extracted source tree on
# stdout so the caller can pipe it to the bundle builder.
#
# Usage:
#   fetch-omeka-release.sh <version> <release-url>
#
# Environment:
#   CACHE_DIR   Override the cache root (default: <repo>/.cache/omeka-release)

set -eu

VERSION=${1:?"fetch-omeka-release.sh: version argument is required"}
URL=${2:?"fetch-omeka-release.sh: release URL argument is required"}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/omeka-release"}
VERSION_DIR="$CACHE_DIR/$VERSION"
ARCHIVE_PATH="$VERSION_DIR/omeka-s-$VERSION.zip"
EXTRACT_DIR="$VERSION_DIR/source"

mkdir -p "$VERSION_DIR"

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Downloading $URL" >&2
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 -o "$ARCHIVE_PATH.part" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$ARCHIVE_PATH.part" "$URL"
  else
    echo "curl or wget is required to download the Omeka release." >&2
    exit 1
  fi
  mv "$ARCHIVE_PATH.part" "$ARCHIVE_PATH"
fi

if [ ! -d "$EXTRACT_DIR" ]; then
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  echo "Extracting $ARCHIVE_PATH" >&2
  unzip -q "$ARCHIVE_PATH" -d "$EXTRACT_DIR"
fi

# Release archives contain a single top-level directory (e.g. "omeka-s").
# Resolve to that inner directory so downstream callers see the source
# tree directly.
INNER=$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
if [ -z "$INNER" ]; then
  echo "Unable to locate extracted Omeka directory inside $EXTRACT_DIR" >&2
  exit 1
fi

printf '%s\n' "$INNER"
