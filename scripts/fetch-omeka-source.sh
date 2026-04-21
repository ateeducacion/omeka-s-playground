#!/bin/sh

# Fetch an Omeka S source tree from a git remote into a cache directory.
# Prints the absolute path of the cloned repository on stdout.
#
# Arguments (all optional for backward compat — fall back to env vars):
#   $1  remote URL (also OMEKA_REF)
#   $2  ref/branch name (also OMEKA_REF_BRANCH)
#   $3  version label used to pick a per-version cache path
#
# Environment:
#   CACHE_DIR          Override cache root (default: <repo>/.cache/omeka-source)
#   OMEKA_REF          Remote URL when $1 is unset
#   OMEKA_REF_BRANCH   Ref when $2 is unset

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/omeka-source"}

REF_URL=${1:-${OMEKA_REF:-"https://github.com/ateeducacion/omeka-s.git"}}
REF_BRANCH=${2:-${OMEKA_REF_BRANCH:-"feature/experimental-sqlite-support"}}
LABEL=${3:-default}

# Use a per-version clone directory so building multiple versions side by
# side doesn't thrash a shared working tree.
SAFE_LABEL=$(printf '%s' "$LABEL" | sed 's/[^A-Za-z0-9._-]/_/g')
CLONE_DIR="$CACHE_DIR/$SAFE_LABEL/repository"

mkdir -p "$CLONE_DIR"

if [ ! -d "$CLONE_DIR/.git" ]; then
  # Clone may have been partially created above; `git clone` refuses to
  # clone into a non-empty directory, so remove it first.
  rm -rf "$CLONE_DIR"
  git clone --depth 1 --branch "$REF_BRANCH" "$REF_URL" "$CLONE_DIR" >&2
else
  git -C "$CLONE_DIR" fetch --depth 1 origin "$REF_BRANCH" >&2
  git -C "$CLONE_DIR" checkout "$REF_BRANCH" >&2
  git -C "$CLONE_DIR" reset --hard "origin/$REF_BRANCH" >&2
fi

printf '%s\n' "$CLONE_DIR"
